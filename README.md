# CSMS IGE2A — Orchestrator & Observability (Supabase-only)

Stack com Orchestrator API (Node 20) e Observabilidade (cAdvisor, Prometheus, Grafana).  
Legados SteVe/MariaDB/OCPP simulator removidos; agora é **Supabase-only**.

---

## 📋 Sumário

- [Arquivos importantes](#arquivos-importantes)
- [Pré-requisitos](#pré-requisitos)
- [Configuração (.env)](#configuração-env)
- [Como rodar](#como-rodar)
- [Serviços & Portas](#serviços--portas)
- [Testes & Validação](#testes--validação)
- [Observabilidade](#observabilidade)
- [Customização local (override)](#customização-local-override)
- [Checks & Auditoria](#checks--auditoria)
- [Troubleshooting](#troubleshooting)

---

## 📁 Arquivos importantes

- **`docker-compose.yml`** → fonte da verdade da stack
- **`monitoring/prometheus/prometheus.yml`** → config Prometheus
- **`services/orchestrator-api/`** → código do Orchestrator
- **`services/orchestrator-api/.env.sample`** → exemplo de variáveis (sem segredos)

⚠️ **Não replique o conteúdo do `docker-compose.yml` no README para evitar divergências.**

---

## ✅ Pré-requisitos

- **Docker Desktop** (Compose v2)
- **Git**
- **(Opcional fora do Docker)** Node 20 e pnpm — o container já instala/roda

---

## ⚙️ Configuração (.env)

Crie `services/orchestrator-api/.env` baseado no `.env.sample` (não comitar segredos):

```env
# Supabase
SUPABASE_URL=https://<sua-instancia>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJI...<exemplo>
# ou, se o serviço não precisa privilégios:
# SUPABASE_ANON_KEY=eyJhbGciOiJI...<exemplo>

# Orchestrator
NODE_ENV=development
TZ=UTC
PORT=3000
ORCH_API_KEY=minha_chave_super_secreta

# OCPP
OCPP_ENGINE_KIND=mock
OCPP_ENGINE_URL=
```

---

## 🚀 Como rodar

```bash
# Subir todos os serviços
docker compose up -d

# Ver logs do orchestrator
docker compose logs -f orchestrator

# Reiniciar só o orchestrator (após alterar código)
docker compose restart orchestrator

# Parar e remover volumes (⚠️ apaga dados locais de Prometheus/Grafana)
docker compose down -v
```

---

## 🌐 Serviços & Portas

| Serviço       | URL / Porta                  | Observações                      |
|---------------|------------------------------|----------------------------------|
| **Orchestrator** | http://localhost:3000     | API, `/readiness`, `/metrics`    |
| **Grafana**      | http://localhost:3001     | Login: `admin` / `admin` (dev)   |
| **Prometheus**   | http://localhost:9090     | Console/queries                  |
| **cAdvisor**     | http://localhost:18081    | Métricas de containers           |

### Health & Métricas

```bash
# Verificar health
curl -fsS http://localhost:3000/readiness && echo "OK"

# Ver métricas
curl -fsS http://localhost:3000/metrics | head
```

---

## 🧪 Testes & Validação

O projeto inclui uma suíte completa de testes para validar o funcionamento do sistema tanto localmente quanto na VM Linux de produção.

### Scripts de Teste Disponíveis

| Script | Descrição | Uso |
|--------|-----------|-----|
| `test-vm-validation.cjs` | Testes específicos para VM Linux | `node test-vm-validation.cjs` |
| `test-api-validation.cjs` | Validação de API e endpoints | `node test-api-validation.cjs` |
| `run-all-tests.cjs` | Executa todos os testes | `node run-all-tests.cjs` |
| `test-backend-simple.cjs` | Testes básicos do backend | `node test-backend-simple.cjs` |

### Testes de Validação da VM Linux

Para testar se o sistema está funcionando corretamente na VM Linux:

```bash
# Testar VM Linux (padrão: http://35.231.137.231:3000)
node test-vm-validation.cjs

# Testar URL customizada
VM_BACKEND_URL=http://sua-vm:3000 node test-vm-validation.cjs
```

**O que é testado:**
- ✅ Health check do backend
- ✅ Listagem de chargers com autenticação
- ✅ Verificação de charger específico (DRBAKANA-TEST-06)
- ✅ Status de telemetria
- ✅ Endpoint SSE (/v1/stream)

### Validação de API e Endpoints

Para validar configuração de API keys e roteamento correto:

```bash
# Validar API local
node test-api-validation.cjs

# Validar API da VM
node test-api-validation.cjs http://35.231.137.231:3000

# Validar ambos os ambientes
node test-api-validation.cjs --full
```

**O que é validado:**
- 🔑 Configuração correta de API keys
- 🛣️ Roteamento correto (/v1/chargers vs /api/v1/chargers)
- 🔒 Autenticação e autorização
- 📊 Estrutura de resposta da API
- ❌ Endpoints incorretos (devem falhar)

### Executar Todos os Testes

```bash
# Executar suíte completa de testes
node run-all-tests.cjs
```

Inclui:
- Testes de validação da VM
- Testes de performance
- Testes de tratamento de erros
- Relatórios em JSON e HTML

### Configuração de Ambiente para Testes

Variáveis de ambiente opcionais:

```bash
# URLs de teste
export LOCAL_BACKEND_URL=http://localhost:3000
export VM_BACKEND_URL=http://35.231.137.231:3000

# API Key (padrão: minha_chave_super_secreta)
export API_KEY=sua_chave_api

# Charger de teste (padrão: DRBAKANA-TEST-06)
export TEST_CHARGE_BOX_ID=DRBAKANA-TEST-06
```

### Relatórios de Teste

Os testes geram relatórios automáticos:

- `vm-validation-test-report.json` - Resultados da validação da VM
- `api-validation-report.json` - Resultados da validação de API
- `full-api-validation-report.json` - Comparação entre ambientes
- `test-report.json` - Relatório completo de todos os testes
- `test-report.html` - Relatório visual em HTML

### Exemplo de Uso na VM Linux

```bash
# 1. Fazer pull das atualizações
git pull origin main

# 2. Executar testes de validação
node test-vm-validation.cjs

# 3. Verificar se todos os testes passaram
echo $?  # 0 = sucesso, 1 = falha

# 4. Ver relatório detalhado
cat vm-validation-test-report.json
```

### Endpoints Testados

| Endpoint | Método | Autenticação | Status Esperado |
|----------|--------|--------------|-----------------|
| `/health` | GET | ❌ Não | 200 |
| `/v1/chargers?lat=-23.5505&lon=-46.6333` | GET | ✅ Sim | 200 |
| `/v1/chargers/DRBAKANA-TEST-06` | GET | ✅ Sim | 200 |
| `/v1/telemetry/status` | GET | ✅ Sim | 200 |
| `/v1/stream` | GET | ❌ Não | 200 (SSE) |

**Endpoints incorretos que devem falhar:**
- `/api/v1/chargers` → 404 (rota incorreta)
- `/v1/chargers` sem API key → 401 (não autorizado)
- `/v1/chargers` com API key inválida → 401 (não autorizado)

---

## 📊 Observabilidade

### Prometheus

Configure targets em `monitoring/prometheus/prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'orchestrator'
    static_configs:
      - targets: ['host.docker.internal:3000']
  
  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']
```

### Grafana

- **Login padrão (dev):** `admin` / `admin`
- Adicione Prometheus como Data Source: `http://prometheus:9090`

---

## 🔧 Customização local (override)

Se precisar mexer em portas/envs sem alterar o compose principal, crie `docker-compose.override.yml` (não versionar, ou ignore via `.gitignore`):

```yaml
services:
  orchestrator:
    environment:
      NODE_OPTIONS: "--dns-result-order=ipv4first"
    ports:
      - "3000:3000"   # pode mudar a porta local aqui
    # exemplo: montar CA corporativo se necessário
    # volumes:
    #   - ./certs/corp-ca.crt:/usr/local/share/ca-certificates/corp-ca.crt:ro
```

O Compose carrega automaticamente o `docker-compose.override.yml` se existir na raiz do projeto.

---

## 🔍 Checks & Auditoria

```bash
# Verificar status dos containers
docker compose ps

# Logs de todos os serviços
docker compose logs

# Inspecionar métricas do Prometheus
curl http://localhost:9090/api/v1/targets

# Ver uso de recursos (cAdvisor)
open http://localhost:18081
```

---

## 🆘 Troubleshooting

### Orchestrator não inicia

1. Verifique se o `.env` existe e está correto
2. Confira logs: `docker compose logs orchestrator`
3. Teste conectividade com Supabase: `curl -I $SUPABASE_URL`

### Prometheus não coleta métricas

- Verifique se o target está `UP` em http://localhost:9090/targets
- Confirme que o Orchestrator expõe `/metrics`
- No Linux, use `host.docker.internal` ou o IP da bridge (`172.17.0.1`)

### Grafana não conecta ao Prometheus

- Use `http://prometheus:9090` (nome do serviço interno)
- Não use `localhost` dentro do container

### Portas em conflito

- Crie `docker-compose.override.yml` e mapeie para portas diferentes
- Ou pare serviços que estejam usando as portas (3000, 3001, 9090, 18081)

---

## 📝 Notas

- **Não comite** arquivos `.env` com credenciais reais
- Mantenha o `docker-compose.yml` como fonte única da verdade
- Use `.env.sample` como template para novos desenvolvedores

---

**Projeto:** CSMS IGE2A  
**Stack:** Node 20, Supabase, Docker, Prometheus, Grafana, cAdvisor
