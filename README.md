# Neto Mundim — LP + Meta Pixel/CAPI

Landing page mobile-first de pré-qualificação de leads com tracking Meta (Pixel + Conversions API) com deduplicação por `event_id`, hashing SHA-256 dos PII e consent gate LGPD.

## Estrutura

```
.
├── Landing Page.html       ← LP única (quiz + tracking client-side)
├── api/
│   └── track.js            ← Serverless function: CAPI com hashing SHA-256
└── README.md
```

## Deploy

### Opção 1 — Vercel (recomendado)
1. `npm i -g vercel` (ou use o dashboard)
2. Na raiz do projeto: `vercel deploy`
3. Configure as env vars em **Project Settings → Environment Variables**:
   - `META_PIXEL_ID` — seu Pixel ID (ex: `1234567890123456`)
   - `META_ACCESS_TOKEN` — token CAPI (**nunca** colocar no frontend)
   - `META_TEST_EVENT_CODE` — opcional, só para Test Events
   - `META_API_VERSION` — opcional, default `v21.0`
4. Troque `{{INSIRA_SEU_PIXEL_ID}}` no `Landing Page.html` pelo Pixel ID real (aparece em 2 lugares: `META_CONFIG.PIXEL_ID` e no `<noscript>` fallback).

### Opção 2 — Netlify
1. Mova `api/track.js` para `netlify/functions/track.js`
2. No `Landing Page.html`, altere `TRACK_ENDPOINT` de `/api/track` para `/.netlify/functions/track`
3. Configure env vars em **Site settings → Environment variables**

### Opção 3 — Outro (Cloudflare Workers, Express, etc.)
Adapte o `api/track.js` (é Node puro, `fetch` nativo) para seu runtime e ajuste `TRACK_ENDPOINT` no frontend.

## Como obter as credenciais Meta

- **Pixel ID**: Events Manager → seu Pixel → **Configurações** → copie o ID no topo.
- **Access Token**: Events Manager → seu Pixel → **Configurações** → **Conversions API** → **Gerar Token de Acesso**. Guarde com cuidado — dá acesso ao envio de eventos.
- **Test Event Code**: Events Manager → **Test Events** → copie o código `TEST12345` que aparece.

## Como testar

1. **Test Events**: preencha `META_TEST_EVENT_CODE` e acesse a LP. Em Events Manager → **Test Events**, você deve ver cada evento aparecendo **duas vezes** com o mesmo `event_id`: uma linha "Browser" (Pixel) e uma "Server" (CAPI), com badge **Deduplicated** verde.
2. **Network tab**: cada disparo deve gerar:
   - Request para `facebook.com/tr?...` (Pixel)
   - Request para `/api/track` (sua função serverless)
3. **Console**: nenhum PII em texto puro — apenas hashes hex de 64 caracteres no payload que vai ao Meta.
4. **Eventos esperados**:
   - `PageView` — no primeiro load (após aceitar consent)
   - `ViewContent` — ao clicar em "Começar"
   - `QuizStep` (custom) — a cada etapa completada, com `step`, `step_id`, `step_label`
   - `QuizComplete` (custom) — ao chegar na tela final
   - `Lead` — ao clicar em "Enviar para o Neto"

## Análise crítica (resumo das decisões)

Esta implementação partiu do prompt Meta CAPI + Pixel e adaptou ao contexto real da LP:

- **Eventos descartados**: `Contact` (redundante com Lead), `InitiateCheckout`, `Purchase`, `Schedule`, `Search` — não existem no fluxo.
- **Eventos custom adicionados**: `QuizStep`, `QuizComplete` — dão visão de funil de abandono que o Meta de padrão não teria.
- **Email e telefone**: adicionados como 2 últimas perguntas do quiz (antes da cidade) para melhorar matching quality. Se quiser remover, tire do array `QUESTIONS` no HTML — o `buildUserData()` já trata campos vazios.
- **Estado/sessão**: a LP não tem login nem carrinho; `external_id` é um UUID persistente em `localStorage` criado no primeiro acesso (após consent).
- **Demográficos**: não pedimos CEP, idade, gênero. Cidade/UF são parseados da resposta "Ex: Uberlândia, MG".

## Troubleshooting

- **"Eventos não aparecem em Test Events"**: confirme que `META_TEST_EVENT_CODE` está preenchido e que você aceitou o consent na LP. Sem consent, zero disparo.
- **"Matching quality baixo"**: verifique que `em`, `ph`, `fn`, `ln` estão vindo preenchidos nos requests para `/api/track` (olhe no Network tab do navegador — os valores antes de sair do browser ainda estão em texto plano; só são hasheados no servidor).
- **"Eventos duplicados sem dedup"**: confirme que o `event_id` é o mesmo em Pixel e CAPI. Se estiver diferente, o Meta vai contar 2x. No código, ele é gerado uma vez em `trackEvent()` e passado para os dois lados.
- **"ACCESS_TOKEN aparece no frontend"**: nunca deve. Só use `process.env.META_ACCESS_TOKEN` dentro de `api/track.js`. Se estiver vazando, revise onde está configurando.

## Trocar o número do WhatsApp

No topo do script em `Landing Page.html`:

```js
const WHATSAPP_NUMBER = '5534984001550'; // ← aqui
```

## Política de Privacidade

O link no banner de consent aponta para `/politica-privacidade` — crie a página ou troque o href.
