# 🚀 Nexus Cripto - Backend API

![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?style=for-the-badge&logo=fastify&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)

API RESTful desenvolvida para o ecossistema Nexus Cripto. Este projeto simula uma carteira de criptomoedas simplificada, focada em transações seguras, sistema de ledger auditável e integrações de webhook com idempotência.

## 📌 Funcionalidades Principais

- **Autenticação Segura:** Sistema de cadastro e login retornando JWT (Access e Refresh Tokens).
- **Gestão de Carteiras:** Suporte nativo para múltiplos tokens (BRL, BTC, ETH) inicializados com saldo zero.
- **Webhook de Depósitos:** Recepção de depósitos via sistemas externos com validação de `idempotencyKey` para evitar duplicidade.
- **Swap de Moedas:** Conversão de moedas consumindo cotação real da API CoinGecko, com aplicação de taxa de serviço (1.5%).
- **Ledger Auditável:** Histórico contábil blindado. Todo o saldo atual pode ser reconstruído a partir do histórico de movimentações.
- **Saques e Extratos:** Endpoints protegidos para retirada de fundos e consulta paginada de transações.

---

## 🛠️ Decisões Técnicas Relevantes

Durante o desenvolvimento, priorizei a **Qualidade e Consistência** em detrimento de implementações superficiais, adotando as seguintes estratégias:

1. **Fastify + Zod:** Embora não fossem obrigatórios, optei por utilizar o Fastify por sua alta performance e o Zod para uma validação de dados extremamente rigorosa nas portas de entrada da API.
2. **Prisma ORM ($transaction):** O coração do sistema financeiro. O uso do método `$transaction` do Prisma garante propriedades ACID. Se houver falha na geração do registro do Ledger durante um Swap ou Saque, o Prisma realiza o *rollback* automático, impedindo saldos fantasmas.
3. **Idempotência no Webhook:** Para tratar o cenário de múltiplas requisições idênticas, defini o campo `idempotencyKey` como `UNIQUE` no banco de dados. O sistema intercepta o erro e retorna status 200 avisando que o processamento já ocorreu, mantendo a consistência do saldo sem causar falhas no serviço emissor.
4. **Regra de Negócio do Swap (Taxa):** Notei uma pequena discrepância no escopo do teste: o texto instruía a *debitar a taxa do token de origem*, enquanto o exemplo visual a debitava do token de destino. Optei por seguir a documentação em texto estritamente, validando e descontando a taxa de 1.5% diretamente do saldo de origem para garantir aderência à regra principal.

---

## 🗄️ Estrutura do Banco de Dados

A arquitetura foi desenhada para garantir total rastreabilidade (Ledger):

*   **`User`**: Gerencia credenciais e centraliza os relacionamentos.
*   **`Wallet`**: Tabela pivot (`userId` + `token`). Garante escalabilidade para adicionar novos tokens no futuro sem alterar colunas de usuários.
*   **`Transaction`**: O evento macro disparado pelo usuário (DEPOSIT, SWAP, WITHDRAWAL).
*   **`Movement`**: As linhas contábeis geradas por uma transação (Ledger). Um único `SWAP`, por exemplo, gera três registros em `Movement` (`SWAP_OUT`, `SWAP_FEE`, `SWAP_IN`), mantendo a rastreabilidade do saldo exato (`oldBalance` -> `newBalance`).

---

## 🚀 Como Executar o Projeto Localmente

### Pré-requisitos
* Node.js instalado.
* Um banco de dados PostgreSQL rodando (local ou na nuvem, como Supabase).

### Passo a Passo

1. **Clone o repositório:**
   ```bash
   git clone <https://github.com/gohenj/nexus-cripto.git>
   cd nexus-backend

2. **Instale as dependências:**
   ```bash
   npm install

3. **Configuração de Variáveis de Ambiente:**
    Crie um arquivo .env na raiz do projeto com as seguintes variáveis:
    ´´´Snippet de código
    DATABASE_URL= postgresql://postgres:MADARA1974m$@db.srdovqgsdrtagefazoau.supabase.co:6543/postgres

4. **Sincronize o Banco de Dados:**
    ´´´bash
    npx prisma db push

    Execute o Prisma para criar a estrutura de tabelas no PostgreSQL:


5. **Inicie o codigo**
    ´´´bash
    npx tsx watch src/server.ts
O servidor iniciará na porta 3333 (http://localhost:3333).

## 👨‍💻 Autor
Desenvolvido por Gustavo Mendonça de Souza como parte do desafio técnico para Desenvolvedor Backend.

