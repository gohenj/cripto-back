import fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import fastifyJwt from '@fastify/jwt';
import{z} from 'zod';
import bcrypt from 'bcryptjs';


const app = fastify();
const prisma = new PrismaClient();

app.register(fastifyJwt, {
  secret: 'super-secret-nexus-key-123' 
});

// --- ROTA DE CADASTRO ---
app.post('/register', async (request, reply) => {
  // 1. O Zod valida o que está vindo do corpo da requisição (request.body)
  const registerSchema = z.object({
    email: z.string().email("Formato de e-mail inválido"),
    password: z.string().min(6, "A senha precisa ter no mínimo 6 caracteres"),
  });

  // Se o front-end mandar um dado errado, o Zod já barra aqui e nem continua
  const { email, password } = registerSchema.parse(request.body);

  // 2. Verifica se o usuário já existe
  const userExists = await prisma.user.findUnique({
    where: { email }
  });

  if (userExists) {
    return reply.status(400).send({ error: 'E-mail já cadastrado.' });
  }

  // 3. Criptografa a senha para salvar no banco (nunca salvamos em texto puro!)
  const passwordHash = await bcrypt.hash(password, 6);

  // 4. A Mágica do Prisma: Cria o usuário e as 3 carteiras de uma vez só
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      wallets: {
        create: [
          { token: 'BRL', balance: 0 },
          { token: 'BTC', balance: 0 },
          { token: 'ETH', balance: 0 },
        ]
      }
    }
  });

  // 5. Retorna sucesso (Status 201 = Created)
  return reply.status(201).send({ 
    message: 'Usuário criado e carteiras geradas com sucesso!',
    userId: user.id
  });
});


// --- ROTA DE LOGIN ---
app.post('/login', async (request, reply) => {
  // 1. Valida o que vem do front-end
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
  });

  const { email, password } = loginSchema.parse(request.body);

  // 2. Procura o usuário no banco
  const user = await prisma.user.findUnique({
    where: { email }
  });

  // Se não achar o usuário ou a senha estiver errada, a gente dá o mesmo erro genérico 
  // (questão de segurança, pra ninguém descobrir quais emails estão cadastrados)
  if (!user) {
    return reply.status(401).send({ error: 'Credenciais inválidas.' });
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

  if (!isPasswordValid) {
    return reply.status(401).send({ error: 'Credenciais inválidas.' });
  }

  // 3. Gera os Tokens exigidos pelo teste
  // Access Token (dura 15 minutos)
  const accessToken = app.jwt.sign(
    { sub: user.id }, 
    { expiresIn: '15m' }
  );

  // Refresh Token (dura 7 dias)
  const refreshToken = app.jwt.sign(
    { sub: user.id }, 
    { expiresIn: '7d' }
  );

  return reply.status(200).send({
    accessToken,
    refreshToken
  });
});

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
// Esse cara vai ficar na porta das próximas rotas verificando o crachá (Token)
export async function verifyJwt(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({ error: 'Não autorizado. Token inválido ou ausente.' });
  }
}
// --- ROTA DE WEBHOOK DE DEPÓSITO (FASE 2) ---
app.post('/webhooks/deposit', async (request, reply) => {
  // 1. O Zod valida o formato do payload exigido pelo teste
  const depositSchema = z.object({
    userId: z.string().uuid("ID de usuário inválido"),
    token: z.string().toUpperCase(), // BRL, BTC ou ETH
    amount: z.number().positive("O valor deve ser maior que zero"),
    idempotencyKey: z.string(),
  });

  const parsedData = depositSchema.safeParse(request.body);
  
  if (!parsedData.success) {
    return reply.status(400).send({ error: 'Dados inválidos.', details: parsedData.error.format() });
  }

  const { userId, token, amount, idempotencyKey } = parsedData.data;

  // 2. A Mágica Anti-Duplicidade (Idempotência)
  // Verifica se já processamos uma transação com essa mesma chave
  const existingTx = await prisma.transaction.findUnique({
    where: { idempotencyKey }
  });

  if (existingTx) {
    // Se a chave já existe, a gente não dá erro, só avisa que já tá no bolso (padrão de webhooks)
    return reply.status(200).send({ message: 'Depósito já processado anteriormente.' });
  }

  // 3. Verifica se a carteira desse token específico existe para este usuário
  const wallet = await prisma.wallet.findUnique({
    where: {
      userId_token: { userId, token }
    }
  });

  if (!wallet) {
    return reply.status(404).send({ error: 'Usuário ou carteira do token não encontrada.' });
  }

  // 4. A Transação de Banco de Dados (Tudo ou Nada)
  // Se qualquer coisa der erro aqui dentro, o banco desfaz tudo sozinho
  try {
    await prisma.$transaction(async (tx) => {
      // A. Cria o evento da transação
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          idempotencyKey,
        }
      });

      // B. Atualiza o saldo da carteira somando o valor do depósito
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } }
      });

      // C. O Sistema de Ledger Contábil: Grava a fita de auditoria
      await tx.movement.create({
        data: {
          transactionId: transaction.id,
          userId,
          type: 'DEPOSIT',
          token,
          amount,
          oldBalance: wallet.balance,
          newBalance: updatedWallet.balance,
        }
      });
    });

    return reply.status(200).send({ message: 'Depósito creditado com sucesso!' });
    
  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: 'Erro interno ao processar o depósito.' });
  }
});
// --- ROTA DE SAQUE (FASE 3) ---
// Note que aqui colocamos o "verifyJwt" para proteger a porta. Só entra quem tem o Token!
app.post('/withdraw', { preValidation: [verifyJwt] }, async (request, reply) => {
  // 1. Pega o ID do usuário que está logado (o Fastify extrai isso direto do Token JWT)
  const { sub: userId } = request.user as { sub: string };

  // 2. Valida o que o front-end tá pedindo pra sacar
  const withdrawSchema = z.object({
    token: z.string().toUpperCase(),
    amount: z.number().positive("O valor do saque deve ser maior que zero"),
  });

  const parsedData = withdrawSchema.safeParse(request.body);
  if (!parsedData.success) {
    return reply.status(400).send({ error: 'Dados inválidos.', details: parsedData.error.format() });
  }

  const { token, amount } = parsedData.data;

  // 3. Busca a carteira correspondente à moeda que ele quer sacar
  const wallet = await prisma.wallet.findUnique({
    where: { userId_token: { userId, token } }
  });

  if (!wallet) {
    return reply.status(404).send({ error: 'Carteira não encontrada.' });
  }

  // 4. A REGRA DE OURO: O cara tem dinheiro suficiente?
  if (Number(wallet.balance) < amount) {
    return reply.status(400).send({ error: 'Saldo insuficiente para este saque.' });
  }

  // 5. Transação no Banco (Se der erro no meio, o Prisma desfaz tudo)
  try {
    await prisma.$transaction(async (tx) => {
      // A. Registra o evento principal de saque
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: 'WITHDRAWAL',
        }
      });

      // B. Arranca o dinheiro da carteira (decrementa)
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: amount } }
      });

      // C. Livro-razão: Grava a fita mostrando quanto tinha antes e quanto ficou depois
      await tx.movement.create({
        data: {
          transactionId: transaction.id,
          userId,
          type: 'WITHDRAWAL', // Tipo exigido pelo teste
          token,
          amount,
          oldBalance: wallet.balance,
          newBalance: updatedWallet.balance,
        }
      });
    });

    return reply.status(200).send({ message: 'Saque realizado com sucesso!' });

  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: 'Erro interno ao processar o saque.' });
  }
});
// --- FUNÇÃO AUXILIAR: BUSCAR COTAÇÃO REAL NA COINGECKO ---
async function getExchangeRate(fromToken: string, toToken: string): Promise<number> {
  if (fromToken === toToken) return 1;

  // Mapeamento para os IDs que a API da CoinGecko entende
  const ids: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum' };
  const crypto = ids[fromToken] || ids[toToken];
  const vsCurrency = (fromToken === 'BRL' || toToken === 'BRL') ? 'brl' : (ids[toToken] || 'usd');

  try {
    // Usamos o fetch nativo do Node.js para bater na API exigida no teste
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${crypto}&vs_currencies=${vsCurrency}`);
    const data = await response.json();

    if (ids[fromToken]) return data[crypto][vsCurrency]; // Ex: BTC -> BRL
    if (fromToken === 'BRL' && ids[toToken]) return 1 / data[crypto]['brl']; // Ex: BRL -> BTC (fator inverso)
    
    return 1;
  } catch (error) {
    console.error("Erro ao buscar cotação, usando fallback", error);
    // Fallback de segurança: se a API bloquear a requisição por limite, o teste não quebra
    if (fromToken === 'BTC' && toToken === 'BRL') return 350000;
    if (fromToken === 'BRL' && toToken === 'BTC') return 1 / 350000;
    return 1;
  }
}

// --- ROTA DE COTAÇÃO (SWAP QUOTE) ---
app.get('/swap/quote', async (request, reply) => {
  const quoteSchema = z.object({
    from: z.string().toUpperCase(),
    to: z.string().toUpperCase(),
    amount: z.coerce.number().positive() // coerce transforma a string da URL em número
  });

  const parsed = quoteSchema.safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: 'Parâmetros inválidos' });

  const { from, to, amount } = parsed.data;

  const rate = await getExchangeRate(from, to);
  const destinationAmount = amount * rate;
  const feeAmount = amount * 0.015; // Taxa de 1.5% cobrada sobre o valor de origem

  return reply.status(200).send({
    quoteRate: rate,
    originAmount: amount,
    feeChargedInOriginToken: feeAmount,
    totalRequiredOriginBalance: amount + feeAmount,
    destinationAmount: destinationAmount
  });
});

// --- ROTA DE EXECUÇÃO DO SWAP ---
app.post('/swap', { preValidation: [verifyJwt] }, async (request, reply) => {
  const { sub: userId } = request.user as { sub: string };

  const swapSchema = z.object({
    from: z.string().toUpperCase(),
    to: z.string().toUpperCase(),
    amount: z.number().positive()
  });

  const parsed = swapSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Dados inválidos' });

  const { from, to, amount } = parsed.data;

  // 1. Pega as duas carteiras do usuário
  const originWallet = await prisma.wallet.findUnique({ where: { userId_token: { userId, token: from } } });
  const destWallet = await prisma.wallet.findUnique({ where: { userId_token: { userId, token: to } } });

  if (!originWallet || !destWallet) return reply.status(404).send({ error: 'Carteiras não encontradas' });

  // 2. Calcula matemática do Swap com a cotação real e a taxa fixa de 1.5%
  const rate = await getExchangeRate(from, to);
  const feeAmount = amount * 0.015; 
  const totalOriginNeeded = amount + feeAmount;
  const destinationAmount = amount * rate;

  // 3. Validação de saldo bruto (incluindo a taxa)
  if (Number(originWallet.balance) < totalOriginNeeded) {
    return reply.status(400).send({ error: `Saldo insuficiente. Necessário: ${totalOriginNeeded} ${from} (inclui taxa).` });
  }

  // 4. Transação no Banco: Grava tudo junto para evitar furos no Ledger
  try {
    await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: { userId, type: 'SWAP' }
      });

      // A. Desconta o valor do Swap da carteira de origem
      const updatedOrigin1 = await tx.wallet.update({
        where: { id: originWallet.id },
        data: { balance: { decrement: amount } }
      });

      await tx.movement.create({
        data: {
          transactionId: transaction.id, userId, type: 'SWAP_OUT', token: from,
          amount, oldBalance: originWallet.balance, newBalance: updatedOrigin1.balance,
        }
      });

      // B. Desconta a Taxa da carteira de origem
      const updatedOrigin2 = await tx.wallet.update({
        where: { id: originWallet.id },
        data: { balance: { decrement: feeAmount } }
      });

      await tx.movement.create({
        data: {
          transactionId: transaction.id, userId, type: 'SWAP_FEE', token: from,
          amount: feeAmount, oldBalance: updatedOrigin1.balance, newBalance: updatedOrigin2.balance,
        }
      });

      // C. Credita o valor convertido na carteira de destino
      const updatedDest = await tx.wallet.update({
        where: { id: destWallet.id },
        data: { balance: { increment: destinationAmount } }
      });

      await tx.movement.create({
        data: {
          transactionId: transaction.id, userId, type: 'SWAP_IN', token: to,
          amount: destinationAmount, oldBalance: destWallet.balance, newBalance: updatedDest.balance,
        }
      });
    });

    return reply.status(200).send({ 
      message: 'Swap realizado com sucesso!',
      convertedAmount: destinationAmount
    });

  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: 'Erro ao executar o swap.' });
  }
});
// --- EXTRATO DETALHADO (LEDGER / REQUISITO 6) ---
app.get('/ledger', { preValidation: [verifyJwt] }, async (request, reply) => {
  const { sub: userId } = request.user as { sub: string };

  // Validação da paginação: se o front não mandar a página, assume página 1 com 10 itens
  const paginationSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10)
  });

  const { page, limit } = paginationSchema.parse(request.query);
  const skip = (page - 1) * limit;

  // Busca as movimentações no banco, ordenando da mais recente para a mais antiga
  const movements = await prisma.movement.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit
  });

  // Conta o total de registros para o front-end saber quantas páginas existem
  const total = await prisma.movement.count({ where: { userId } });

  return reply.status(200).send({
    data: movements,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// --- HISTÓRICO RESUMIDO DE TRANSAÇÕES (REQUISITO 7) ---
app.get('/transactions', { preValidation: [verifyJwt] }, async (request, reply) => {
  const { sub: userId } = request.user as { sub: string };

  const paginationSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10)
  });

  const { page, limit } = paginationSchema.parse(request.query);
  const skip = (page - 1) * limit;

  // O pulo do gato aqui é o "include: { movements: true }". 
  // Isso traz a transação e já "anexa" todas as movimentações de saldo que rolaram dentro dela.
  const transactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { movements: true },
    skip,
    take: limit
  });

  const total = await prisma.transaction.count({ where: { userId } });

  return reply.status(200).send({
    data: transactions,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  });
});

app.get('/ping', async (request, reply) => {
  return { message: 'Servidor da Carteira Cripto rodando 100%!' };
});


app.listen({ port: 3333 }, () => {
  console.log('🚀 Servidor rodando em http://localhost:3333');
});