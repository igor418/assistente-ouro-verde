require('dotenv').config();
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT_SISTEMA } = require('./prompt.js');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PRAZOS_ETAPA = {
  'triagem': 3,
  'interagir grupo': 14,
  'apresentação do negócio': 10,
  'negociação': 14,
};

function diasDesde(dataIso) {
  return Math.floor((Date.now() - new Date(dataIso).getTime()) / 86400000);
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

app.get('/dashboard', async (req, res) => {
  try {
    const token = process.env.PIPEDRIVE_API_KEY;
    const base = 'https://api.pipedrive.com/v1';

    const pipelinesRes = await fetch(`${base}/pipelines?api_token=${token}`);
    const { data: pipelines } = await pipelinesRes.json();

    const pipeline = pipelines?.find(
      p => p.name === '[COMERCIAL] VENDAS GRUPOS PGRS/SAV/ETC'
    );
    if (!pipeline) return res.status(404).json({ erro: 'Pipeline não encontrado.' });

    const dealsRes = await fetch(
      `${base}/deals?pipeline_id=${pipeline.id}&status=open&limit=500&api_token=${token}`
    );
    const { data: deals } = await dealsRes.json();

    const ordem = { alerta: 0, atencao: 1, ok: 2 };

    const oportunidades = (deals || [])
      .map(deal => {
        const etapa = (deal.stage_name || '').trim();
        const prazoMax = PRAZOS_ETAPA[etapa.toLowerCase()] ?? null;
        const diasNaEtapa = diasDesde(deal.stage_change_time || deal.add_time);

        let status = 'ok';
        if (prazoMax !== null) {
          if (diasNaEtapa > prazoMax) status = 'alerta';
          else if (diasNaEtapa >= prazoMax * 0.8) status = 'atencao';
        }

        return {
          id: deal.id,
          nome: deal.title,
          etapa,
          diasNaEtapa,
          prazoMax,
          valor: deal.value,
          moeda: deal.currency,
          status,
        };
      })
      .sort((a, b) => ordem[a.status] - ordem[b.status]);

    res.json({ oportunidades });
  } catch (err) {
    console.error('Erro Pipedrive:', err.message);
    res.status(500).json({ erro: 'Erro ao buscar dados do Pipedrive.' });
  }
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}
