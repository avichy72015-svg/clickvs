import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const LOBBY_WAIT_MS = 60_000;
const ROUND_MS = 60_000;
const COUNTDOWN_MS = 3_000;

const botNames = [
  "בוט בזק",
  "קליקטרון",
  "הבוט הלוחץ",
  "טורבו-בוט",
  "נינג׳ת קליקים",
];

function normalizeCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

function normalizeName(name: string, fallback: string) {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, 24);
  return trimmed || fallback;
}

function hashCode(code: string) {
  let hash = 0;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 31 + code.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function botNameFor(code: string) {
  return botNames[hashCode(code) % botNames.length];
}

function botTargetFor(code: string) {
  return 330 + (hashCode(code) % 140);
}

function phaseFor(game: Doc<"games">, now: number) {
  if (game.status === "waiting") {
    return "waiting";
  }
  if (game.startsAt !== undefined && now < game.startsAt) {
    return "countdown";
  }
  if (game.endsAt !== undefined && now < game.endsAt) {
    return "active";
  }
  return "finished";
}

function scoreForPlayer(player: Doc<"players">, game: Doc<"games">, now: number) {
  if (!player.isBot) {
    return player.score;
  }
  if (game.startsAt === undefined || game.endsAt === undefined || now < game.startsAt) {
    return 0;
  }

  const targetScore = player.botTargetScore ?? botTargetFor(game.code);
  const elapsed = Math.min(now, game.endsAt) - game.startsAt;
  const progress = Math.max(0, Math.min(1, elapsed / ROUND_MS));
  const rhythm = Math.sin(progress * Math.PI * 10 + targetScore) * 5;
  const ramp = progress < 1 ? progress * (0.92 + 0.08 * Math.sin(progress * Math.PI)) : 1;

  return Math.max(0, Math.min(targetScore, Math.floor(targetScore * ramp + rhythm)));
}

async function getOpponent(ctx: MutationCtx, gameId: Id<"games">) {
  return await ctx.db
    .query("players")
    .withIndex("by_game_id_and_role", (q) =>
      q.eq("gameId", gameId).eq("role", "opponent"),
    )
    .unique();
}

async function startRound(ctx: MutationCtx, gameId: Id<"games">, now: number) {
  const startsAt = now + COUNTDOWN_MS;
  await ctx.db.patch("games", gameId, {
    status: "running",
    startsAt,
    endsAt: startsAt + ROUND_MS,
  });
}

async function attachBotOpponent(ctx: MutationCtx, game: Doc<"games">, now: number) {
  const existingOpponent = await getOpponent(ctx, game._id);
  if (existingOpponent !== null || game.status !== "waiting") {
    return false;
  }

  await ctx.db.insert("players", {
    gameId: game._id,
    playerId: `bot:${game.code}`,
    name: botNameFor(game.code),
    role: "opponent",
    isBot: true,
    score: 0,
    color: "coral",
    botTargetScore: botTargetFor(game.code),
  });
  await startRound(ctx, game._id, now);
  return true;
}

export const createGame = mutation({
  args: {
    code: v.string(),
    hostPlayerId: v.string(),
    hostName: v.string(),
  },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (code.length < 8) {
      throw new Error("קוד המשחק קצר מדי.");
    }

    const existingGame = await ctx.db
      .query("games")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (existingGame !== null) {
      throw new Error("הקישור הזה כבר קיים. נסו שוב.");
    }

    const now = Date.now();
    const gameId = await ctx.db.insert("games", {
      code,
      createdAt: now,
      hostPlayerId: args.hostPlayerId,
      lobbyExpiresAt: now + LOBBY_WAIT_MS,
      status: "waiting",
    });

    await ctx.db.insert("players", {
      gameId,
      playerId: args.hostPlayerId,
      name: normalizeName(args.hostName, "המארח"),
      role: "host",
      isBot: false,
      score: 0,
      color: "cyan",
    });

    await ctx.scheduler.runAfter(LOBBY_WAIT_MS, internal.games.attachBotIfWaiting, {
      gameId,
    });

    return { gameId, code };
  },
});

export const joinGame = mutation({
  args: {
    code: v.string(),
    playerId: v.string(),
    playerName: v.string(),
  },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    const game = await ctx.db
      .query("games")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (game === null) {
      throw new Error("המשחק לא נמצא.");
    }

    const existingPlayer = await ctx.db
      .query("players")
      .withIndex("by_game_id_and_player_id", (q) =>
        q.eq("gameId", game._id).eq("playerId", args.playerId),
      )
      .unique();
    if (existingPlayer !== null) {
      return { gameId: game._id, role: existingPlayer.role };
    }

    const now = Date.now();
    if (game.status !== "waiting") {
      return { gameId: game._id, role: null };
    }

    if (now > game.lobbyExpiresAt) {
      await attachBotOpponent(ctx, game, now);
      return { gameId: game._id, role: null };
    }

    const opponent = await getOpponent(ctx, game._id);
    if (opponent !== null || args.playerId === game.hostPlayerId) {
      return { gameId: game._id, role: null };
    }

    await ctx.db.insert("players", {
      gameId: game._id,
      playerId: args.playerId,
      name: normalizeName(args.playerName, "האורח"),
      role: "opponent",
      isBot: false,
      score: 0,
      color: "coral",
    });
    await startRound(ctx, game._id, now);

    return { gameId: game._id, role: "opponent" };
  },
});

export const recordClicks = mutation({
  args: {
    gameId: v.id("games"),
    playerId: v.string(),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.amount)) {
      return { accepted: 0 };
    }

    const amount = Math.max(1, Math.min(80, Math.floor(args.amount)));
    const game = await ctx.db.get("games", args.gameId);
    const now = Date.now();

    if (
      game === null ||
      game.status !== "running" ||
      game.startsAt === undefined ||
      game.endsAt === undefined ||
      now < game.startsAt ||
      now > game.endsAt
    ) {
      return { accepted: 0 };
    }

    const player = await ctx.db
      .query("players")
      .withIndex("by_game_id_and_player_id", (q) =>
        q.eq("gameId", args.gameId).eq("playerId", args.playerId),
      )
      .unique();
    if (player === null || player.isBot) {
      return { accepted: 0 };
    }

    await ctx.db.patch("players", player._id, {
      score: player.score + amount,
      lastClickAt: now,
    });

    return { accepted: amount };
  },
});

export const getByCode = query({
  args: {
    code: v.string(),
    viewerPlayerId: v.string(),
  },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    const game = await ctx.db
      .query("games")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (game === null) {
      return null;
    }

    const now = Date.now();
    const players = await ctx.db
      .query("players")
      .withIndex("by_game_id", (q) => q.eq("gameId", game._id))
      .take(3);
    const viewer = players.find((player) => player.playerId === args.viewerPlayerId) ?? null;
    const phase = phaseFor(game, now);
    const orderedPlayers = players
      .map((player) => ({
        id: player._id,
        playerId: player.playerId,
        name: player.name,
        role: player.role,
        isBot: player.isBot,
        color: player.color,
        score: scoreForPlayer(player, game, now),
        botTargetScore: player.botTargetScore ?? null,
      }))
      .sort((left, right) => (left.role === "host" ? -1 : 1) - (right.role === "host" ? -1 : 1));

    return {
      id: game._id,
      code: game.code,
      createdAt: game.createdAt,
      hostPlayerId: game.hostPlayerId,
      lobbyExpiresAt: game.lobbyExpiresAt,
      status: game.status,
      startsAt: game.startsAt ?? null,
      endsAt: game.endsAt ?? null,
      phase,
      serverNow: now,
      viewerRole: viewer?.role ?? null,
      canJoin:
        viewer === null &&
        game.status === "waiting" &&
        now <= game.lobbyExpiresAt &&
        players.length < 2 &&
        args.viewerPlayerId !== game.hostPlayerId,
      players: orderedPlayers,
    };
  },
});

export const attachBotIfWaiting = internalMutation({
  args: {
    gameId: v.id("games"),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get("games", args.gameId);
    if (game === null || game.status !== "waiting") {
      return null;
    }

    await attachBotOpponent(ctx, game, Date.now());
    return null;
  },
});
