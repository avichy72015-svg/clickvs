import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  games: defineTable({
    code: v.string(),
    createdAt: v.number(),
    hostPlayerId: v.string(),
    lobbyExpiresAt: v.number(),
    status: v.union(v.literal("waiting"), v.literal("running")),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
  }).index("by_code", ["code"]),

  players: defineTable({
    gameId: v.id("games"),
    playerId: v.string(),
    name: v.string(),
    role: v.union(v.literal("host"), v.literal("opponent")),
    isBot: v.boolean(),
    score: v.number(),
    color: v.union(v.literal("cyan"), v.literal("coral")),
    botTargetScore: v.optional(v.number()),
    lastClickAt: v.optional(v.number()),
  })
    .index("by_game_id", ["gameId"])
    .index("by_game_id_and_player_id", ["gameId", "playerId"])
    .index("by_game_id_and_role", ["gameId", "role"]),
});
