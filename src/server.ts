import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import { PrismaClient } from "@prisma/client";
import fastifyJwt from "@fastify/jwt";
import { z } from "zod";
import bcrypt from "bcryptjs";

const app = fastify({ logger: true });
app.register(fastifyCors, {
  origin: true, 
});
const prisma = new PrismaClient();

app.register(fastifyJwt, {
  secret: "super-secret-nexus-key-123",
});

app.post("/register", async (request, reply) => {

  const registerSchema = z.object({
    email: z.string().email("Formato de e-mail inválido"),
    password: z.string().min(6, "A senha precisa ter no mínimo 6 caracteres"),
  });

  
  const { email, password } = registerSchema.parse(request.body);

  
  const userExists = await prisma.user.findUnique({
    where: { email },
  });

  if (userExists) {
    return reply.status(400).send({ error: "E-mail já cadastrado." });
  }

  
  const passwordHash = await bcrypt.hash(password, 6);

  
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      wallets: {
        create: [
          { token: "BRL", balance: 0 },
          { token: "BTC", balance: 0 },
          { token: "ETH", balance: 0 },
        ],
      },
    },
  });

  
  return reply.status(201).send({
    message: "Usuário criado e carteiras geradas com sucesso!",
    userId: user.id,
  });
});


app.post("/login", async (request, reply) => {
  
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
  });

  const { email, password } = loginSchema.parse(request.body);

  
  const user = await prisma.user.findUnique({
    where: { email },
  });

  
  
  if (!user) {
    return reply.status(401).send({ error: "Credenciais inválidas." });
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

  if (!isPasswordValid) {
    return reply.status(401).send({ error: "Credenciais inválidas." });
  }

  
  
  const accessToken = app.jwt.sign({ sub: user.id }, { expiresIn: "15m" });

  
  const refreshToken = app.jwt.sign({ sub: user.id }, { expiresIn: "7d" });

  return reply.status(200).send({
    accessToken,
    refreshToken,
  });
});



export async function verifyJwt(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply
      .status(401)
      .send({ error: "Não autorizado. Token inválido ou ausente." });
  }
}

app.post("/webhooks/deposit", async (request, reply) => {
  
  const depositSchema = z.object({
    userId: z.string().uuid("ID de usuário inválido"),
    token: z.string().toUpperCase(), 
    amount: z.number().positive("O valor deve ser maior que zero"),
    idempotencyKey: z.string(),
  });

  const parsedData = depositSchema.safeParse(request.body);

  if (!parsedData.success) {
    return reply
      .status(400)
      .send({ error: "Dados inválidos.", details: parsedData.error.format() });
  }

  const { userId, token, amount, idempotencyKey } = parsedData.data;

  
  
  const existingTx = await prisma.transaction.findUnique({
    where: { idempotencyKey },
  });

  if (existingTx) {
    
    return reply
      .status(200)
      .send({ message: "Depósito já processado anteriormente." });
  }

  
  const wallet = await prisma.wallet.findUnique({
    where: {
      userId_token: { userId, token },
    },
  });

  if (!wallet) {
    return reply
      .status(404)
      .send({ error: "Usuário ou carteira do token não encontrada." });
  }

  
  
  try {
    await prisma.$transaction(async (tx) => {
      
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "DEPOSIT",
          idempotencyKey,
        },
      });

      
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });

      
      await tx.movement.create({
        data: {
          transactionId: transaction.id,
          userId,
          type: "DEPOSIT",
          token,
          amount,
          oldBalance: wallet.balance,
          newBalance: updatedWallet.balance,
        },
      });
    });

    return reply
      .status(200)
      .send({ message: "Depósito creditado com sucesso!" });
  } catch (error) {
    console.error(error);
    return reply
      .status(500)
      .send({ error: "Erro interno ao processar o depósito." });
  }
});


app.post(
  "/withdraw",
  { preValidation: [verifyJwt] },
  async (request, reply) => {
    
    const { sub: userId } = request.user as { sub: string };

    
    const withdrawSchema = z.object({
      token: z.string().toUpperCase(),
      amount: z.number().positive("O valor do saque deve ser maior que zero"),
    });

    const parsedData = withdrawSchema.safeParse(request.body);
    if (!parsedData.success) {
      return reply
        .status(400)
        .send({
          error: "Dados inválidos.",
          details: parsedData.error.format(),
        });
    }

    const { token, amount } = parsedData.data;

    
    const wallet = await prisma.wallet.findUnique({
      where: { userId_token: { userId, token } },
    });

    if (!wallet) {
      return reply.status(404).send({ error: "Carteira não encontrada." });
    }

    
    if (Number(wallet.balance) < amount) {
      return reply
        .status(400)
        .send({ error: "Saldo insuficiente para este saque." });
    }

    
    try {
      await prisma.$transaction(async (tx) => {
        
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: "WITHDRAWAL",
          },
        });

        
        const updatedWallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { decrement: amount } },
        });

        
        await tx.movement.create({
          data: {
            transactionId: transaction.id,
            userId,
            type: "WITHDRAWAL", 
            token,
            amount,
            oldBalance: wallet.balance,
            newBalance: updatedWallet.balance,
          },
        });
      });

      return reply
        .status(200)
        .send({ message: "Saque realizado com sucesso!" });
    } catch (error) {
      console.error(error);
      return reply
        .status(500)
        .send({ error: "Erro interno ao processar o saque." });
    }
  },
);

async function getExchangeRate(
  fromToken: string,
  toToken: string,
): Promise<number> {
  if (fromToken === toToken) return 1;

  
  const ids: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum" };
  const crypto = ids[fromToken] || ids[toToken];
  const vsCurrency =
    fromToken === "BRL" || toToken === "BRL" ? "brl" : ids[toToken] || "usd";

  try {
    
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${crypto}&vs_currencies=${vsCurrency}`
    );
    const data = await response.json();

    if (ids[fromToken]) return data[crypto][vsCurrency]; 
    if (fromToken === "BRL" && ids[toToken]) return 1 / data[crypto]["brl"]; 

    return 1;
  } catch (error) {
    console.error("Erro ao buscar cotação, usando fallback", error);
    
    if (fromToken === "BTC" && toToken === "BRL") return 350000;
    if (fromToken === "BRL" && toToken === "BTC") return 1 / 350000;
    return 1;
  }
}


app.get("/swap/quote", async (request, reply) => {
  const quoteSchema = z.object({
    from: z.string().toUpperCase(),
    to: z.string().toUpperCase(),
    amount: z.coerce.number().positive(), 
  });

  const parsed = quoteSchema.safeParse(request.query);
  if (!parsed.success)
    return reply.status(400).send({ error: "Parâmetros inválidos" });

  const { from, to, amount } = parsed.data;

  const rate = await getExchangeRate(from, to);
  const destinationAmount = amount * rate;
  const feeAmount = amount * 0.015; 

  return reply.status(200).send({
    quoteRate: rate,
    originAmount: amount,
    feeChargedInOriginToken: feeAmount,
    totalRequiredOriginBalance: amount + feeAmount,
    destinationAmount: destinationAmount,
  });
});


app.post("/swap", { preValidation: [verifyJwt] }, async (request, reply) => {
  const { sub: userId } = request.user as { sub: string };

  const swapSchema = z.object({
    from: z.string().toUpperCase(),
    to: z.string().toUpperCase(),
    amount: z.number().positive(),
  });

  const parsed = swapSchema.safeParse(request.body);
  if (!parsed.success)
    return reply.status(400).send({ error: "Dados inválidos" });

  const { from, to, amount } = parsed.data;

  
  const originWallet = await prisma.wallet.findUnique({
    where: { userId_token: { userId, token: from } },
  });
  const destWallet = await prisma.wallet.findUnique({
    where: { userId_token: { userId, token: to } },
  });

  if (!originWallet || !destWallet)
    return reply.status(404).send({ error: "Carteiras não encontradas" });

  
  const rate = await getExchangeRate(from, to);
  const feeAmount = amount * 0.015;
  const totalOriginNeeded = amount + feeAmount;
  const destinationAmount = amount * rate;

  
  if (Number(originWallet.balance) < totalOriginNeeded) {
    return reply
      .status(400)
      .send({
        error: `Saldo insuficiente. Necessário: ${totalOriginNeeded} ${from} (inclui taxa).`,
      });
  }

  
  try {
    await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: { userId, type: "SWAP" },
      });

      
      const updatedOrigin1 = await tx.wallet.update({
        where: { id: originWallet.id },
        data: { balance: { decrement: amount } },
      });

      await tx.movement.create({
        data: {
          transactionId: transaction.id,
          userId,
          type: "SWAP_OUT",
          token: from,
          amount,
          oldBalance: originWallet.balance,
          newBalance: updatedOrigin1.balance,
        },
      });

      
      const updatedOrigin2 = await tx.wallet.update({
        where: { id: originWallet.id },
        data: { balance: { decrement: feeAmount } },
      });

      await tx.movement.create({
        data: {
          transactionId: transaction.id,
          userId,
          type: "SWAP_FEE",
          token: from,
          amount: feeAmount,
          oldBalance: updatedOrigin1.balance,
          newBalance: updatedOrigin2.balance,
        },
      });

      
      const updatedDest = await tx.wallet.update({
        where: { id: destWallet.id },
        data: { balance: { increment: destinationAmount } },
      });

      await tx.movement.create({
        data: {
          transactionId: transaction.id,
          userId,
          type: "SWAP_IN",
          token: to,
          amount: destinationAmount,
          oldBalance: destWallet.balance,
          newBalance: updatedDest.balance,
        },
      });
    });

    return reply.status(200).send({
      message: "Swap realizado com sucesso!",
      convertedAmount: destinationAmount,
    });
  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: "Erro ao executar o swap." });
  }
});

app.get("/ledger", { preValidation: [verifyJwt] }, async (request, reply) => {
  const { sub: userId } = request.user as { sub: string };

  
  const paginationSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10),
  });

  const { page, limit } = paginationSchema.parse(request.query);
  const skip = (page - 1) * limit;

  
  const movements = await prisma.movement.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
  });

  
  const total = await prisma.movement.count({ where: { userId } });

  return reply.status(200).send({
    data: movements,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
});


app.get(
  "/transactions",
  { preValidation: [verifyJwt] },
  async (request, reply) => {
    const { sub: userId } = request.user as { sub: string };

    const paginationSchema = z.object({
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(10),
    });

    const { page, limit } = paginationSchema.parse(request.query);
    const skip = (page - 1) * limit;

    
    
    const transactions = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { movements: true },
      skip,
      take: limit,
    });

    const total = await prisma.transaction.count({ where: { userId } });

    return reply.status(200).send({
      data: transactions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

app.get("/ping", async (request, reply) => {
  return { message: "Servidor da Carteira Cripto rodando 100%!" };
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));