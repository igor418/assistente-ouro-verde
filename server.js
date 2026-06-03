require('dotenv').config();
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT_SISTEMA } = require('./prompt.js');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ETAPAS_COMERCIAIS = new Set([256, 201, 202, 203, 204, 205]);

const PRAZOS_ETAPA = {
  'triagem': 3,
  'interagir grupo': 14,
  'apresentação do negócio': 10,
  'negociação': 14,
};

function diasDesde(dataIso) {
  return Math.floor((Date.now() - new Date(dataIso).getTime()) / 86400000);
}

// Para campos date-only (ex: "2026-05-10") — evita deslocamento de timezone
function diasDesdeData(dataStr) {
  if (!dataStr) return null;
  const [y, m, d] = dataStr.split('-').map(Number);
  return Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / 86400000);
}

function temContatoDeal(deal) {
  const pessoa = deal.person_id;
  if (!pessoa) return false;
  if (typeof pessoa === 'object') {
    const emails = (pessoa.email || []).filter(e => e.value);
    const phones = (pessoa.phone || []).filter(p => p.value);
    return emails.length > 0 || phones.length > 0;
  }
  return true;
}

function classificarDeal(dias, temContato, valor) {
  if (!temContato || valor === 0 || dias > 120) return 'SAIR';
  if (dias <= 15 && valor >= 10000) return 'PRONTO_FECHAR';
  if (dias >= 16 && dias <= 60 && valor >= 3000) return 'MORNO';
  if (dias >= 61 && dias <= 120 && valor >= 5000) return 'ULTIMA_TENTATIVA';
  return 'SAIR';
}

app.post('/analisar', async (req, res) => {
  const { dados } = req.body;

  if (!dados || !dados.trim()) {
    return res.status(400).json({ erro: 'Dados não informados.' });
  }

  try {
    const mensagem = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: PROMPT_SISTEMA,
      messages: [{ role: 'user', content: dados }],
    });

    const analise = mensagem.content[0].text;
    res.json({ analise });
  } catch (err) {
    console.error('Erro na API Anthropic:', err.message);
    res.status(500).json({ erro: 'Erro ao processar análise.' });
  }
});

app.get('/etapas', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const resp = await fetch(`https://api.pipedrive.com/v1/stages?pipeline_id=31&api_token=${token}`);
    const { data: stages } = await resp.json();
    res.json((stages || []).map(s => ({ id: s.id, nome: s.name })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/debug', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const base = 'https://api.pipedrive.com/v1';

    const pipelinesRes = await fetch(`${base}/pipelines?api_token=${token}`);
    const pipelinesJson = await pipelinesRes.json();

    const pipeline = pipelinesJson.data?.find(
      p => p.name === '[COMERCIAL] VENDAS GRUPOS PGRS/SAV/ETC'
    );
    if (!pipeline) return res.json({ erro: 'Pipeline não encontrado', pipelines: pipelinesJson });

    const dealsRes = await fetch(
      `${base}/deals?pipeline_id=${pipeline.id}&status=open&limit=3&api_token=${token}`
    );
    const dealsJson = await dealsRes.json();
    const dealsFiltered = (dealsJson.data || []).filter(d => ETAPAS_COMERCIAIS.has(d.stage_id));

    res.json({ pipeline, total_antes_filtro: (dealsJson.data || []).length, deals: { ...dealsJson, data: dealsFiltered } });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});


app.get('/triagem', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const base = 'https://api.pipedrive.com/v1';

    const pipelinesRes = await fetch(`${base}/pipelines?api_token=${token}`);
    const { data: pipelines } = await pipelinesRes.json();
    const pipeline = pipelines?.find(p => p.name === '[COMERCIAL] VENDAS GRUPOS PGRS/SAV/ETC');
    if (!pipeline) return res.status(404).json({ erro: 'Pipeline não encontrado.' });

    const dealsRes = await fetch(
      `${base}/deals?pipeline_id=${pipeline.id}&status=open&limit=500&api_token=${token}`
    );
    const rawDeals = (await dealsRes.json()).data || [];
    const deals = rawDeals.filter(d => ETAPAS_COMERCIAIS.has(d.stage_id));

    const resultado = { PRONTO_FECHAR: [], MORNO: [], ULTIMA_TENTATIVA: [], SAIR: [] };

    for (const deal of (deals || [])) {
      const dias = diasDesdeData(deal.last_activity_date) ?? diasDesde(deal.add_time);
      const contato = temContatoDeal(deal);
      const valor = deal.value || 0;
      const categoria = classificarDeal(dias, contato, valor);

      const unidadesMatch = deal.title?.match(/\((\d+)\)/);

      resultado[categoria].push({
        id: deal.id,
        nome: deal.title,
        unidades: unidadesMatch ? parseInt(unidadesMatch[1]) : null,
        diasSemAtividade: dias,
        temContato: contato,
        valor,
        moeda: deal.currency,
        categoria,
      });
    }

    for (const lista of Object.values(resultado)) {
      lista.sort((a, b) => b.valor - a.valor);
    }

    res.json(resultado);
  } catch (err) {
    console.error('Erro triagem:', err.message);
    res.status(500).json({ erro: 'Erro ao buscar dados.' });
  }
});

const PROMPT_ESTRATEGIA = `Você é assistente comercial da Ouro Verde Meio Ambiente.
Gere estratégia de contato direta e específica para o contexto.
Se categoria for PRONTO_FECHAR: foco em conseguir contato do decisor.
Se MORNO: enviar conteúdo de valor antes de vender.
Se ULTIMA_TENTATIVA: mensagem de ruptura curta que gera resposta pelo contrário.
Se SAIR: não gerar mensagem — apenas confirmar o arquivamento.
Máximo 5 linhas. Sem enrolação.`;

app.post('/estrategia', async (req, res) => {
  const { negocio, categoria, canal } = req.body;
  if (!negocio || !categoria) return res.status(400).json({ erro: 'Dados incompletos.' });

  try {
    const mensagem = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      system: PROMPT_ESTRATEGIA,
      messages: [{ role: 'user', content: `Negócio: ${negocio}\nCategoria: ${categoria}\nCanal: ${canal || 'WhatsApp'}` }],
    });
    res.json({ estrategia: mensagem.content[0].text });
  } catch (err) {
    console.error('Erro estratégia:', err.message);
    res.status(500).json({ erro: 'Erro ao gerar estratégia.' });
  }
});

app.post('/arquivar', async (req, res) => {
  const { dealId } = req.body;
  if (!dealId) return res.status(400).json({ erro: 'dealId obrigatório.' });

  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const resp = await fetch(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'lost' }),
    });
    const json = await resp.json();
    if (!json.success) return res.status(400).json({ erro: 'Falha ao arquivar no Pipedrive.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro arquivar:', err.message);
    res.status(500).json({ erro: 'Erro ao arquivar negócio.' });
  }
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}
