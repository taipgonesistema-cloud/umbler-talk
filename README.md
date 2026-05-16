# Umbler Talk - Disparo Rápido

Painel web para envio de mensagens em lote via API do Umbler Talk com agendamento, templates e processamento em background.

## Funcionalidades

- Filtrar contatos por tags/categorias
- Templates de mensagem (sistema ou respostas rápidas da API)
- Placeholder `{{nome}}` para personalização
- Envio imediato ou agendado
- Processamento em lotes de ~50 com pausas aleatórias (anti-block)
- Painel de acompanhamento de disparos em tempo real
- Cancelamento de mensagens agendadas
- Responsivo (mobile/desktop)

## Requisitos

- Node.js 24+
- Conta no Umbler Talk com token de API

## Configuração

```bash
cp .env.example .env
```

Preencha as variáveis no `.env`:

| Variável | Descrição |
|---|---|
| `UTALK_API_TOKEN` | Token Bearer da API Umbler Talk |
| `FROM_PHONE` | Telefone principal (Atacado) |
| `FROM_PHONE_2` | Telefone secundário (Varejo) |
| `ORGANIZATION_ID` | ID da organização |

## Uso

```bash
npm install
npm start
```

Acesse `http://localhost:3000`.

### Docker

```bash
docker-compose up
```

## Estrutura

```
├── server.js              # Backend Express + proxy API
├── public/index.html      # Frontend SPA
├── .env.example           # Template de configuração
├── Dockerfile
└── docker-compose.yml
```
