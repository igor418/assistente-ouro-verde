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

async function fetchAllDeals(token, pipelineId, status = 'open') {
  const base = 'https://api.pipedrive.com/v1';
  let todos = [];
  let start = 0;
  const limit = 100;

  while (true) {
    const url = `${base}/deals?pipeline_id=${pipelineId}&status=${status}&start=${start}&limit=${limit}&api_token=${token}`;
    const res = await fetch(url);
    const json = await res.json();
    const page = json.data || [];
    todos = todos.concat(page);
    if (json.additional_data?.pagination?.more_items_in_collection) {
      start += limit;
    } else {
      break;
    }
  }

  return todos;
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

app.get('/pipelines', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const resp = await fetch(`https://api.pipedrive.com/v1/pipelines?api_token=${token}`);
    const { data } = await resp.json();
    res.json((data || []).map(p => ({ id: p.id, nome: p.name })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/etapas-parceiros', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const resp = await fetch(`https://api.pipedrive.com/v1/stages?pipeline_id=9&api_token=${token}`);
    const { data: stages } = await resp.json();
    res.json((stages || []).map(s => ({ id: s.id, nome: s.name })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
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

    const rawDeals = await fetchAllDeals(token, pipeline.id);
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

app.get('/parceiros', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const base = 'https://api.pipedrive.com/v1';

    const [stagesRes, rawDeals] = await Promise.all([
      fetch(`${base}/stages?pipeline_id=9&api_token=${token}`),
      fetchAllDeals(token, 9),
    ]);

    const { data: stages } = await stagesRes.json();
    const deals = rawDeals;

    const stageMap = Object.fromEntries((stages || []).map(s => [s.id, s.name]));

    const ASSINAR       = new Set([136]);
    const ASSINADO      = new Set([299]);
    const NEG_STAGES    = new Set([37, 39]);
    const FRIO_STAGES   = new Set([36, 130]);
    const STAGES_VALIDOS = new Set([36, 37, 39, 130, 136, 299]);

    const resultado = { ASSINAR_AGORA: [], NEGOCIANDO: [], FRIO: [], CONTRATO_ASSINADO: [] };

    for (const deal of (deals || [])) {
      const sid = deal.stage_id;
      if (!STAGES_VALIDOS.has(sid)) continue; // ignora stages fora do escopo

      const diasSemAtividade = diasDesdeData(deal.last_activity_date) ?? diasDesde(deal.add_time);

      let categoria;
      if (ASSINAR.has(sid))            categoria = 'ASSINAR_AGORA';
      else if (ASSINADO.has(sid))      categoria = 'CONTRATO_ASSINADO';
      else if (NEG_STAGES.has(sid))    categoria = 'NEGOCIANDO';
      else                             categoria = diasSemAtividade > 14 ? 'FRIO' : 'NEGOCIANDO';

      resultado[categoria].push({
        id: deal.id,
        nome: deal.title,
        orgNome: deal.org_name || null,
        etapa: stageMap[sid] || '',
        diasSemAtividade,
        categoria,
      });
    }

    for (const lista of Object.values(resultado)) {
      lista.sort((a, b) => b.diasSemAtividade - a.diasSemAtividade);
    }

    res.json(resultado);
  } catch (err) {
    console.error('Erro parceiros:', err.message);
    res.status(500).json({ erro: 'Erro ao buscar parceiros.' });
  }
});

const PROMPT_ESTRATEGIA_PARCEIRO = `Você é assistente da Ouro Verde Meio Ambiente.
Este funil é de PARCERIAS ESTRATÉGICAS — pipeline_id 9.
Os parceiros fazem a propaganda da Ouro Verde nas suas redes — sindicatos, associações de marca, Sincodiv's.
O objetivo é assinar contrato com todos e nunca perder nenhum parceiro já assinado.

Se ASSINAR_AGORA: mensagem para acelerar a assinatura. Tom: parceiro, direto, sem pressão de venda.

Se NEGOCIANDO: manter o momentum. Perguntar sobre próximos passos, remover obstáculos.

Se FRIO: resgatar com conteúdo de valor. Mencionar cases recentes da Ouro Verde.

Se CONTRATO_ASSINADO: relacionamento genuíno e contínuo. Compartilhar novidade relevante, perguntar como estão as ações conjuntas, reforçar o valor da parceria. Nunca deixar o parceiro sentir que só é contatado quando precisam de algo.

Máximo 5 linhas. Tom parceiro, nunca comercial.`;

app.post('/estrategia-parceiro', async (req, res) => {
  const { negocio, categoria } = req.body;
  if (!negocio || !categoria) return res.status(400).json({ erro: 'Dados incompletos.' });

  try {
    const mensagem = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      system: PROMPT_ESTRATEGIA_PARCEIRO,
      messages: [{ role: 'user', content: `Parceiro: ${negocio}\nCategoria: ${categoria}` }],
    });
    res.json({ estrategia: mensagem.content[0].text });
  } catch (err) {
    console.error('Erro estratégia-parceiro:', err.message);
    res.status(500).json({ erro: 'Erro ao gerar estratégia.' });
  }
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}
