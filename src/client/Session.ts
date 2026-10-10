// One running game as the client sees it: the engine worker, the stream of
// turns feeding it (from a local clock or from the server) and the GameState
// mirror the renderer reads.

import { TileRef } from "@crusades/engine-api/game/GameMap";
import {
  BuildableUnit,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerActions,
  PlayerBuildableUnitType,
} from "@crusades/engine-api/game/GameTypes";
import {
  ErrorUpdate,
  GameUpdateType,
  GameUpdateViewData,
} from "@crusades/engine-api/game/GameUpdates";
import { GameStartInfo, Intent } from "@crusades/engine-api/Schemas";
import {
  MainThreadMessage,
  WorkerMessage,
} from "@crusades/engine-api/worker/WorkerMessages";
import type { Rules } from "../net/Protocol";
import { SocketTransport } from "../net/SocketTransport";
import { LocalTransport, Transport } from "../net/Transport";
import { loadRealm, Realm } from "../worldgen/RealmGen";
import { Cosmetic, GameState, TickDelta } from "./GameState";

export interface SessionOptions {
  name: string;
  map: GameMapType;
  seed: number;
  difficulty: Difficulty;
  clans: number;
  kingdoms: number;
  /** Endless gold and instant building, for trying things out. */
  sandbox: boolean;
  /** House rules, as a private lobby has them. */
  rules?: Rules;
  /** No human player: just watch the AI realms fight. */
  spectate?: boolean;
  /** What the player wears (from their account). */
  cosmetic?: Cosmetic;
}

/** Everything a Session needs, however the game was arranged. */
export interface SessionSetup {
  realm: Realm;
  info: GameStartInfo;
  /** The local player's id in `info.players`; undefined to spectate. */
  clientID: string | undefined;
  transport: Transport;
  /** Turns already played, to replay when rejoining a game in progress. */
  catchup?: number;
  /** What each human wears, by client id. */
  cosmetics?: ReadonlyMap<string, Cosmetic>;
}

const SOLO_ID = "LIEGE001";

function randomID(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += abc[(Math.random() * abc.length) | 0];
  return s;
}

/** A game against the AI, with the clock in this page. */
export async function soloSession(options: SessionOptions): Promise<Session> {
  const realm = await loadRealm({
    map: options.map,
    seed: options.seed,
    kingdoms: options.kingdoms,
  });
  const rules = options.rules ?? {};
  const info: GameStartInfo = {
    gameID: randomID(),
    lobbyCreatedAt: 0,
    config: {
      gameMap: options.map,
      difficulty: options.difficulty,
      donateGold: !rules.noGoldGifts,
      donateTroops: !rules.noLevyGifts,
      // A solo game starts when the player picks a seat. With nobody to
      // pick one, use the timed opening the engine gives shared games.
      gameType: options.spectate ? GameType.Private : GameType.Singleplayer,
      gameMode: GameMode.FFA,
      gameMapSize: GameMapSize.Normal,
      nations: options.kingdoms > 0 ? "default" : "disabled",
      bots: options.clans,
      infiniteGold: options.sandbox || (rules.infiniteGold ?? false),
      infiniteTroops: rules.infiniteTroops ?? false,
      instantBuild: options.sandbox || (rules.instantBuild ?? false),
      randomSpawn: false,
      // The same reading of the rules as the game server gives a private lobby.
      ...(rules.noPacts ? { disableAlliances: true } : {}),
      ...(rules.startingGold ? { startingGold: rules.startingGold } : {}),
      ...(rules.goldMultiplier && rules.goldMultiplier !== 1 ? { goldMultiplier: rules.goldMultiplier } : {}),
      ...(rules.truceSeconds ? { spawnImmunityDuration: rules.truceSeconds * 10 } : {}),
      ...(rules.limitMinutes ? { maxTimerValue: rules.limitMinutes } : {}),
      ...(rules.pactMinutes ? { customAllianceDuration: rules.pactMinutes } : {}),
      ...(rules.banned && rules.banned.length > 0 ? { disabledUnits: rules.banned } : {}),
    },
    players: options.spectate
      ? []
      : [{ clientID: SOLO_ID, username: options.name, clanTag: null }],
  };
  let session: Session;
  // Don't run ahead of a worker that is still chewing on earlier turns, and
  // hold the clock while the player is choosing a seat.
  const transport = new LocalTransport(
    SOLO_ID,
    () => session.inFlight < 6,
    () => session.waitingForSeat(),
  );
  session = new Session({
    realm,
    info,
    clientID: options.spectate ? undefined : SOLO_ID,
    transport,
    cosmetics: options.cosmetic ? new Map([[SOLO_ID, options.cosmetic]]) : undefined,
  });
  return session;
}

export class Session {
  readonly realm: Realm;
  readonly state: GameState;
  readonly clientID: string | undefined;
  /** Wall-clock time the last tick arrived, for interpolation. */
  lastTickAt = performance.now();
  /** Turns sent to the worker that haven't come back as ticks yet. */
  inFlight = 0;
  onTick: (delta: TickDelta) => void = () => {};
  onError: (message: string) => void = () => {};
  /** Engine state hashes, for the server to compare between players. */
  onHash: (tick: number, hash: number) => void = () => {};
  /** The turn stream skipped or repeated: the game is unrecoverable without a resync. */
  onGap: (expected: number, got: number) => void = () => {};

  private worker: Worker;
  private transport: Transport;
  private turns = 0;
  private seatAskedAt = -100;
  private waiting = new Map<string, (m: WorkerMessage) => void>();
  private info: GameStartInfo;
  private catchupLeft: number;

  constructor(readonly setup: SessionSetup) {
    this.realm = setup.realm;
    this.info = setup.info;
    this.clientID = setup.clientID;
    this.transport = setup.transport;
    this.catchupLeft = setup.catchup ?? 0;
    this.state = new GameState(this.realm, this.info.config, this.clientID ?? "", setup.cosmetics);
    this.worker = new Worker(
      new URL("../../packages/engine/src/worker/Worker.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.addEventListener("message", (e: MessageEvent<WorkerMessage>) =>
      this.onMessage(e.data),
    );
    this.worker.addEventListener("error", (e) =>
      this.onError(e.message || "The engine worker failed to load."),
    );
    // Online, hold back turns the engine has not got to yet (see SocketTransport).
    if (this.transport instanceof SocketTransport) this.transport.ready = () => this.inFlight < 60;
    this.transport.onTurn = (turn) => {
      if (turn.turnNumber !== this.turns) {
        // A missed or repeated turn means this game can never match the others.
        console.error(`Turn ${turn.turnNumber} arrived, expected ${this.turns}`);
        this.onGap(this.turns, turn.turnNumber);
        return;
      }
      this.turns++;
      this.inFlight++;
      this.post({ type: "turn", turn });
    };
  }

  /** Only a solo player owns the clock, so only they may pause or hurry. */
  get ownsClock(): boolean {
    return this.transport.ownsClock;
  }
  private get local(): LocalTransport | null {
    return this.transport instanceof LocalTransport ? this.transport : null;
  }
  get paused(): boolean {
    return this.local?.paused ?? false;
  }
  set paused(v: boolean) {
    if (this.local) this.local.paused = v;
  }
  get speed(): number {
    return this.local?.speed ?? 1;
  }
  set speed(v: number) {
    if (this.local) this.local.speed = v;
  }

  /** Still replaying turns from before we joined. */
  get catchingUp(): boolean {
    return this.catchupLeft > 0;
  }

  async start(): Promise<void> {
    const files = this.realm.files;
    const transfer: Transferable[] = [];
    if (files.mapBin) transfer.push(files.mapBin.buffer);
    if (files.map4xBin) transfer.push(files.map4xBin.buffer);
    const reply = await this.ask(
      { type: "init", gameStartInfo: this.info, clientID: this.clientID, map: files },
      transfer,
    );
    if (reply.type === "init_error") throw new Error(reply.error);
    this.transport.start();
  }

  stop() {
    this.transport.stop();
    this.worker.terminate();
  }

  send(intent: Intent) {
    if (intent.type === "spawn") this.seatAskedAt = this.turns;
    this.transport.send(intent);
  }

  /**
   * Seats can only be taken during the opening, and the opening is short.
   * Once the rival realms have appeared, time stands still until the player
   * has picked a spot. (A request takes a couple of turns to be granted, so
   * a recent one keeps the clock running.)
   */
  waitingForSeat(): boolean {
    return (
      this.clientID !== undefined &&
      this.state.inSpawnPhase &&
      this.turns >= 40 &&
      !this.state.me?.hasSpawned &&
      this.turns - this.seatAskedAt > 4
    );
  }

  private onMessage(m: WorkerMessage) {
    switch (m.type) {
      case "game_update":
        this.update(m.gameUpdate);
        break;
      case "game_update_batch":
        for (const gu of m.gameUpdates) this.update(gu);
        break;
      case "game_error":
        this.fail(m.error);
        break;
      default:
        if (m.id && this.waiting.has(m.id)) {
          const fn = this.waiting.get(m.id)!;
          this.waiting.delete(m.id);
          fn(m);
        }
    }
  }

  private update(gu: GameUpdateViewData) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.catchupLeft > 0) this.catchupLeft--;
    this.lastTickAt = performance.now();
    for (const h of gu.updates[GameUpdateType.Hash]) this.onHash(h.tick, h.hash);
    this.onTick(this.state.apply(gu));
  }

  private fail(e: ErrorUpdate) {
    console.error(e.errMsg, e.stack);
    this.onError(e.errMsg);
  }

  private post(m: MainThreadMessage, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private ask(m: MainThreadMessage, transfer: Transferable[] = []): Promise<WorkerMessage> {
    const id = randomID();
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ ...m, id }, transfer);
    });
  }

  /** How long a tick lasts on the wall clock right now. */
  tickMs(): number {
    return this.transport.turnMs();
  }

  async actions(
    tile: TileRef | null,
    units?: readonly PlayerBuildableUnitType[] | null,
  ): Promise<PlayerActions | null> {
    const me = this.state.me;
    if (!me) return null;
    const map = this.state.map;
    const reply = await this.ask({
      type: "player_actions",
      playerID: me.id,
      x: tile === null ? undefined : map.x(tile),
      y: tile === null ? undefined : map.y(tile),
      units,
    });
    return reply.type === "player_actions_result" ? reply.result : null;
  }

  /** Where each of my attacks (out and in) is being fought, as tile coordinates. */
  async attackPositions(): Promise<{ id: string; positions: { x: number; y: number }[] }[]> {
    const me = this.state.me;
    if (!me) return [];
    const reply = await this.ask({ type: "attack_clustered_positions", playerID: me.smallID });
    return reply.type === "attack_clustered_positions_result" ? reply.attacks : [];
  }

  async buildables(
    tile: TileRef | null,
    units?: readonly PlayerBuildableUnitType[],
  ): Promise<BuildableUnit[]> {
    const me = this.state.me;
    if (!me) return [];
    const map = this.state.map;
    const reply = await this.ask({
      type: "player_buildables",
      playerID: me.id,
      x: tile === null ? undefined : map.x(tile),
      y: tile === null ? undefined : map.y(tile),
      units,
    });
    return reply.type === "player_buildables_result" ? reply.result : [];
  }
}
