/* app/page.tsx */
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";

/* =========================
   TYPES
========================= */

type PlayerStats = {
  name: string;
  drinks: number; // user-controlled
  cardsDrawn: number;

  // tracked events (no auto-drinks)
  qmCaught: number; // times they were caught answering QM
  powerLosses: number; // last-to-tap losses (heaven/thumb)
};

type PowerKind = "heaven" | "thumb";

type PowerRound = {
  kind: PowerKind;
  active: boolean;
  startedBy: string; // holder who started it
  eligible: string[]; // snapshot at start
  tapped: string[]; // order of taps; last = loser
  loser: string | null;
  startedAt: number;
};

type WaterfallState =
  | null
  | {
      phase: "pending" | "active";
      drawer: string;
      durationSec: number; // random 5-20
      startedAt: number | null; // set on start
      direction: "clockwise";
    };

type KingRule = {
  id: string;
  text: string;
  by: string;
  createdAt: number;
};

type GameState = {
  host: string | null;
  deck: string[];
  currentCard: string | null;

  turn: string | null;
  lastDrawBy: string | null;

  players: Record<string, PlayerStats>;

  // badges / holders
  heavenHolder: string | null; // 7
  thumbHolder: string | null; // J
  qmHolder: string | null; // Q (Question Master)
  kingHolder: string | null; // K

  powerRound: PowerRound | null;
  waterfall: WaterfallState;
  kingRules: KingRule[];
};

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW"; requestedBy?: string }
  | { type: "UPDATE"; id: string; patch: Partial<PlayerStats> }
  | { type: "POWER_START"; kind: PowerKind; requestedBy: string }
  | { type: "POWER_TAP"; kind: PowerKind; by: string }
  | { type: "POWER_CLEAR"; requestedBy: string }
  | { type: "WATERFALL_START"; requestedBy: string }
  | { type: "QM_CAUGHT"; requestedBy: string; target: string }
  | { type: "KING_ADD_RULE"; requestedBy: string; text: string }
  | { type: "KING_REMOVE_RULE"; requestedBy: string; ruleId: string };

/* =========================
   HELPERS
========================= */

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const d: string[] = [];
  for (const r of ranks) for (const s of suits) d.push(`${r}${s}`);
  return d;
}

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function encode(obj: any) {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function decode(buf: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

type Layout = "l1" | "l2" | "l3" | "l4" | "l5" | "l6";

function computeVideoLayout(count: number): Layout {
  if (count <= 1) return "l1";
  if (count === 2) return "l2";
  if (count === 3) return "l3";
  if (count === 4) return "l4";
  if (count === 5) return "l5";
  return "l6";
}

function parseCard(card: string | null): { rank: string; suit: string } {
  if (!card) return { rank: "—", suit: "" };
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  return { rank, suit };
}

function isRedSuit(suit: string) {
  return suit === "♥" || suit === "♦";
}

function ruleForCard(card: string | null): string {
  if (!card) return "Draw to start.";
  const { rank } = parseCard(card);

  // NOTE: These descriptions match the mechanics implemented below for A/7/J/Q/K.
  switch (rank) {
    case "A":
      return "Ace = Waterfall. Drawer starts it; random 5–20s; clockwise; deck locked while pending/active.";
    case "2":
      return "2 = You choose someone to drink.";
    case "3":
      return "3 = You drink.";
    case "4":
      return "4 = Whores (girls drink).";
    case "5":
      return "5 = Guys drink.";
    case "6":
      return "6 = Dicks / Kyle’sADick (everyone drinks).";
    case "7":
      return "7 = Heaven power. Holder can start anytime; last to tap loses; holder stays until next 7.";
    case "8":
      return "8 = Mate (pick a mate).";
    case "9":
      return "9 = Rhyme (go around).";
    case "10":
      return "10 = Categories (go around).";
    case "J":
      return "Jack = Thumb power. Holder can start anytime; last to tap loses; holder stays until next Jack.";
    case "Q":
      return "Question Master. If you answer, QM can tag you (tracked). QM stays until next Q.";
    case "K":
      return "King = Make a rule. King can add rules (persist until removed). King stays until next K.";
    default:
      return "House rules.";
  }
}

/* =========================
   FULLSCREEN
========================= */

async function requestFullscreenSafe() {
  const el: any = document.documentElement as any;
  const fn =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.mozRequestFullScreen ||
    el.msRequestFullscreen;
  if (fn) await fn.call(el);
}

async function exitFullscreenSafe() {
  const d: any = document as any;
  const fn = d.exitFullscreen || d.webkitExitFullscreen || d.mozCancelFullScreen || d.msExitFullscreen;
  if (fn) await fn.call(d);
}

function isFullscreenNow() {
  const d: any = document as any;
  return !!(d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement);
}

/* =========================
   MAIN APP
========================= */

export default function Page() {
  const roomRef = useRef<Room | null>(null);
  const me = useRef<string>("");

  const emptyState: GameState = {
    host: null,
    deck: [],
    currentCard: null,
    turn: null,
    lastDrawBy: null,
    players: {},

    heavenHolder: null,
    thumbHolder: null,
    qmHolder: null,
    kingHolder: null,

    powerRound: null,
    waterfall: null,
    kingRules: [],
  };

  const stateRef = useRef<GameState>(clone(emptyState));

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState("");

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [isFs, setIsFs] = useState(false);

  const [state, setState] = useState<GameState>(clone(emptyState));

  // small toast
  const [toast, setToast] = useState<string>("");
  const toastTimer = useRef<any>(null);

  // modals
  const [qmOpen, setQmOpen] = useState(false);
  const [kingOpen, setKingOpen] = useState(false);
  const [kingText, setKingText] = useState("");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }

  useEffect(() => {
    const onChange = () => setIsFs(isFullscreenNow());
    document.addEventListener("fullscreenchange", onChange);
    // @ts-ignore
    document.addEventListener("webkitfullscreenchange", onChange);
    // @ts-ignore
    document.addEventListener("mozfullscreenchange", onChange);
    // @ts-ignore
    document.addEventListener("MSFullscreenChange", onChange);

    setIsFs(isFullscreenNow());
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      // @ts-ignore
      document.removeEventListener("webkitfullscreenchange", onChange);
      // @ts-ignore
      document.removeEventListener("mozfullscreenchange", onChange);
      // @ts-ignore
      document.removeEventListener("MSFullscreenChange", onChange);
    };
  }, []);

  async function toggleFullscreen() {
    try {
      if (isFullscreenNow()) await exitFullscreenSafe();
      else await requestFullscreenSafe();
    } catch {
      // ignore
    } finally {
      setIsFs(isFullscreenNow());
    }
  }

  /* =========================
     NETWORK
  ========================= */

  async function send(msg: Msg) {
    const r = roomRef.current;
    if (!r) return;
    await r.localParticipant.publishData(encode(msg), { reliable: true });
  }

  /* =========================
     GAME LOGIC
  ========================= */

  function ensurePlayer(gs: GameState, id: string) {
    if (!id) return;
    if (!gs.players[id]) {
      gs.players[id] = { name: id, drinks: 0, cardsDrawn: 0, qmCaught: 0, powerLosses: 0 };
    } else {
      // backward-safe fill
      if (typeof gs.players[id].qmCaught !== "number") gs.players[id].qmCaught = 0;
      if (typeof gs.players[id].powerLosses !== "number") gs.players[id].powerLosses = 0;
    }
  }

  function getTurnOrder(gs: GameState): string[] {
    const ids = Object.keys(gs.players).filter(Boolean);
    const host = gs.host ? [gs.host] : [];
    const rest = ids.filter((x) => x !== gs.host).sort((a, b) => a.localeCompare(b));
    const merged = [...host, ...rest];
    return Array.from(new Set(merged)).slice(0, 6);
  }

  function advanceTurn(gs: GameState): string | null {
    const order = getTurnOrder(gs);
    if (!order.length) return gs.host;

    const cur = gs.turn && order.includes(gs.turn) ? gs.turn : order[0];
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length];
    return next || order[0] || gs.host;
  }

  function holderFor(gs: GameState, kind: PowerKind): string | null {
    return kind === "heaven" ? gs.heavenHolder : gs.thumbHolder;
  }

  function canStartPower(gs: GameState, kind: PowerKind, who: string): boolean {
    const holder = holderFor(gs, kind);
    if (!holder || holder !== who) return false;
    if (gs.powerRound?.active) return false;
    return true;
  }

  function startPowerRoundHost(gs: GameState, kind: PowerKind, startedBy: string): GameState {
    const next = clone(gs);
    const holder = holderFor(next, kind);
    if (!holder || holder !== startedBy) return next;
    if (next.powerRound?.active) return next;

    const eligible = getTurnOrder(next);
    if (startedBy && !eligible.includes(startedBy)) eligible.unshift(startedBy);

    next.powerRound = {
      kind,
      active: true,
      startedBy,
      eligible: eligible.slice(0, 6),
      tapped: [],
      loser: null,
      startedAt: Date.now(),
    };

    return next;
  }

  function tapPowerHost(gs: GameState, kind: PowerKind, by: string): GameState {
    const next = clone(gs);
    const pr = next.powerRound;
    if (!pr || !pr.active || pr.kind !== kind) return next;
    if (!by) return next;

    if (!pr.eligible.includes(by)) return next;
    if (pr.tapped.includes(by)) return next;

    pr.tapped.push(by);

    if (pr.tapped.length >= pr.eligible.length) {
      pr.active = false;
      pr.loser = pr.tapped[pr.tapped.length - 1] || null;

      // track loss (no auto drinks)
      if (pr.loser) {
        ensurePlayer(next, pr.loser);
        next.players[pr.loser].powerLosses = (next.players[pr.loser].powerLosses || 0) + 1;
      }
    }

    next.powerRound = pr;
    return next;
  }

  function clearPowerHost(gs: GameState): GameState {
    const next = clone(gs);
    next.powerRound = null;
    return next;
  }

  function isDeckLocked(gs: GameState): boolean {
    // ONLY Ace waterfall locks draw
    return !!gs.waterfall && (gs.waterfall.phase === "pending" || gs.waterfall.phase === "active");
  }

  function startWaterfallHost(gs: GameState, requestedBy: string): GameState {
    const next = clone(gs);
    const wf = next.waterfall;
    if (!wf) return next;
    if (wf.phase !== "pending") return next;
    if (wf.drawer !== requestedBy) return next;

    wf.phase = "active";
    wf.startedAt = Date.now();
    next.waterfall = wf;

    return next;
  }

  function tickWaterfallHost(gs: GameState): GameState {
    const next = clone(gs);
    const wf = next.waterfall;
    if (!wf || wf.phase !== "active" || !wf.startedAt) return next;

    const elapsed = (Date.now() - wf.startedAt) / 1000;
    if (elapsed >= wf.durationSec) {
      // done: clear + NOW advance turn (turn stayed on drawer during waterfall)
      next.waterfall = null;
      next.turn = advanceTurn(next);
    }
    return next;
  }

  function qmCaughtHost(gs: GameState, qmBy: string, target: string): GameState {
    const next = clone(gs);
    if (!next.qmHolder || next.qmHolder !== qmBy) return next;
    if (!target || target === qmBy) return next;

    ensurePlayer(next, target);
    next.players[target].qmCaught = (next.players[target].qmCaught || 0) + 1;
    return next;
  }

  function kingAddRuleHost(gs: GameState, by: string, text: string): GameState {
    const next = clone(gs);
    if (!next.kingHolder || next.kingHolder !== by) return next;
    const clean = text.trim();
    if (!clean) return next;

    next.kingRules = [
      { id: uid("rule"), text: clean, by, createdAt: Date.now() },
      ...(next.kingRules || []),
    ].slice(0, 20);

    return next;
  }

  function kingRemoveRuleHost(gs: GameState, requestedBy: string, ruleId: string): GameState {
    const next = clone(gs);
    const rules = next.kingRules || [];
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) return next;

    const isHost = next.host === requestedBy;
    const isOwner = rule.by === requestedBy;

    if (!isHost && !isOwner) return next;

    next.kingRules = rules.filter((r) => r.id !== ruleId);
    return next;
  }

  async function draw() {
    const r = roomRef.current;
    if (!r) return;

    const current = stateRef.current;

    // lock only for Ace waterfall
    if (isDeckLocked(current)) {
      showToast("Deck locked (Waterfall).");
      return;
    }

    // host draws; guests request draw
    if (current.host !== me.current) {
      await send({ type: "DRAW", requestedBy: me.current });
      return;
    }

    const next = clone(current);

    if (!next.deck.length) next.deck = shuffle(buildDeck());

    const card = next.deck.shift() || null;
    next.currentCard = card;

    ensurePlayer(next, me.current);
    next.players[me.current].cardsDrawn++;
    next.lastDrawBy = me.current;

    const { rank } = parseCard(card);

    // holders update on draw of their card
    if (rank === "7") next.heavenHolder = me.current;
    if (rank === "J") next.thumbHolder = me.current;
    if (rank === "Q") next.qmHolder = me.current; // Question Master
    if (rank === "K") next.kingHolder = me.current;

    // Ace mechanics: set waterfall pending, keep turn on drawer until done
    if (rank === "A") {
      const durationSec = Math.floor(5 + Math.random() * 16); // 5..20 inclusive
      next.waterfall = {
        phase: "pending",
        drawer: me.current,
        durationSec,
        startedAt: null,
        direction: "clockwise",
      };
      next.turn = me.current; // stay on drawer
    } else {
      next.waterfall = null; // any non-ace draw clears any stale wf
      next.turn = advanceTurn(next);
    }

    setState(next);
    await send({ type: "STATE", data: next });
  }

  async function changeDrink(n: number) {
    const current = stateRef.current;
    const next = clone(current);
    ensurePlayer(next, me.current);

    next.players[me.current].drinks = Math.max(0, next.players[me.current].drinks + n);

    setState(next);

    await send({
      type: "UPDATE",
      id: me.current,
      patch: { drinks: next.players[me.current].drinks },
    });
  }

  async function startPower(kind: PowerKind) {
    const current = stateRef.current;

    if (current.host !== me.current) {
      await send({ type: "POWER_START", kind, requestedBy: me.current });
      return;
    }

    const next = startPowerRoundHost(current, kind, me.current);
    setState(next);
    await send({ type: "STATE", data: next });
  }

  async function tapPower(kind: PowerKind) {
    const current = stateRef.current;

    if (current.host !== me.current) {
      await send({ type: "POWER_TAP", kind, by: me.current });
      return;
    }

    const next = tapPowerHost(current, kind, me.current);
    setState(next);
    await send({ type: "STATE", data: next });
  }

  async function clearPower() {
    const current = stateRef.current;

    if (current.host !== me.current) {
      await send({ type: "POWER_CLEAR", requestedBy: me.current });
      return;
    }

    const next = clearPowerHost(current);
    setState(next);
    await send({ type: "STATE", data: next });
  }

  async function startWaterfall() {
    const current = stateRef.current;
    const wf = current.waterfall;
    if (!wf || wf.phase !== "pending") return;

    if (current.host !== me.current) {
      await send({ type: "WATERFALL_START", requestedBy: me.current });
      return;
    }

    const next = startWaterfallHost(current, me.current);
    setState(next);
    await send({ type: "STATE", data: next });
  }

  async function qmCaught(target: string) {
    const current = stateRef.current;
    if (!current.qmHolder || current.qmHolder !== me.current) return;

    if (current.host !== me.current) {
      await send({ type: "QM_CAUGHT", requestedBy: me.current, target });
      return;
    }

    const next = qmCaughtHost(current, me.current, target);
    setState(next);
    await send({ type: "STATE", data: next });
    showToast(`${target} answered the Question Master. (Tracked)`);
  }

  async function kingAddRule() {
    const text = kingText.trim();
    if (!text) return;

    const current = stateRef.current;
    if (!current.kingHolder || current.kingHolder !== me.current) return;

    setKingOpen(false);
    setKingText("");

    if (current.host !== me.current) {
      await send({ type: "KING_ADD_RULE", requestedBy: me.current, text });
      return;
    }

    const next = kingAddRuleHost(current, me.current, text);
    setState(next);
    await send({ type: "STATE", data: next });
    showToast("Rule added.");
  }

  async function kingRemoveRule(ruleId: string) {
    const current = stateRef.current;

    if (current.host !== me.current) {
      await send({ type: "KING_REMOVE_RULE", requestedBy: me.current, ruleId });
      return;
    }

    const next = kingRemoveRuleHost(current, me.current, ruleId);
    setState(next);
    await send({ type: "STATE", data: next });
  }

  /* =========================
     VIDEO ATTACHMENT
  ========================= */

  function attachTrackToIdentity(track: any, identity: string) {
    const v = document.querySelector(`video[data-video-for="${CSS.escape(identity)}"]`) as HTMLVideoElement | null;
    if (!v) return;
    try {
      track.attach(v);
    } catch {
      // ignore
    }
  }

  async function attachLocalTracks(room: Room, identity: string) {
    room.localParticipant.videoTrackPublications.forEach((pub) => {
      const track = pub.track;
      if (!track) return;
      if (track.kind === Track.Kind.Video) attachTrackToIdentity(track, identity);
    });
  }

  /* =========================
     CONNECT / DISCONNECT
  ========================= */

  async function connect() {
    setErrMsg("");

    const roomName = roomCode.trim();
    const identity = name.trim();

    if (!roomName || !identity) {
      setErrMsg("Enter a room + name.");
      return;
    }

    setJoining(true);

    try {
      const res = await fetch(`/api/token?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(identity)}`);
      const data = await res.json();

      if (!res.ok) throw new Error(data?.error || `Token API failed (${res.status})`);
      if (!data?.token || !data?.url) throw new Error("Token API returned missing token/url.");

      const room = new Room();
      roomRef.current = room;
      me.current = identity;

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        setState((s) => {
          const n = clone(s);
          ensurePlayer(n, participant.identity);
          if (!n.turn) n.turn = n.host || participant.identity;
          return n;
        });

        if (track.kind === Track.Kind.Video) attachTrackToIdentity(track, participant.identity);
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        setState((s) => {
          const n = clone(s);
          ensurePlayer(n, participant.identity);
          if (!n.turn) n.turn = n.host || participant.identity;
          return n;
        });
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        setState((s) => {
          const n = clone(s);

          if (n.players[participant.identity]) delete n.players[participant.identity];
          if (n.turn === participant.identity) n.turn = advanceTurn(n);

          if (n.heavenHolder === participant.identity) n.heavenHolder = null;
          if (n.thumbHolder === participant.identity) n.thumbHolder = null;
          if (n.qmHolder === participant.identity) n.qmHolder = null;
          if (n.kingHolder === participant.identity) n.kingHolder = null;

          if (n.powerRound?.active) {
            const pr = n.powerRound;
            pr.eligible = pr.eligible.filter((id) => id !== participant.identity);
            pr.tapped = pr.tapped.filter((id) => id !== participant.identity);

            if (pr.eligible.length > 0 && pr.tapped.length >= pr.eligible.length) {
              pr.active = false;
              pr.loser = pr.tapped[pr.tapped.length - 1] || null;

              if (pr.loser) {
                ensurePlayer(n, pr.loser);
                n.players[pr.loser].powerLosses = (n.players[pr.loser].powerLosses || 0) + 1;
              }
            }
            n.powerRound = pr;
          }

          // if waterfall drawer leaves, cancel waterfall
          if (n.waterfall && n.waterfall.drawer === participant.identity) {
            n.waterfall = null;
            n.turn = advanceTurn(n);
          }

          return n;
        });
      });

      room.on(RoomEvent.DataReceived, (buf) => {
        const msg = decode(buf);
        if (!msg) return;

        if (msg.type === "STATE") {
          const incoming: GameState = {
            host: msg.data.host ?? null,
            deck: msg.data.deck ?? [],
            currentCard: msg.data.currentCard ?? null,
            turn: msg.data.turn ?? msg.data.host ?? null,
            lastDrawBy: msg.data.lastDrawBy ?? null,
            players: msg.data.players ?? {},

            heavenHolder: msg.data.heavenHolder ?? null,
            thumbHolder: msg.data.thumbHolder ?? null,
            qmHolder: msg.data.qmHolder ?? null,
            kingHolder: msg.data.kingHolder ?? null,

            powerRound: msg.data.powerRound ?? null,
            waterfall: msg.data.waterfall ?? null,
            kingRules: msg.data.kingRules ?? [],
          };

          // backward-safe stats
          for (const id of Object.keys(incoming.players)) ensurePlayer(incoming, id);

          setState(incoming);
          return;
        }

        if (msg.type === "DRAW") {
          const current = stateRef.current;
          if (roomRef.current && me.current && current.host === me.current) draw();
          return;
        }

        if (msg.type === "POWER_START") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const next = startPowerRoundHost(current, msg.kind as PowerKind, msg.requestedBy as string);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        if (msg.type === "POWER_TAP") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const next = tapPowerHost(current, msg.kind as PowerKind, msg.by as string);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        if (msg.type === "POWER_CLEAR") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const requestedBy = msg.requestedBy as string;

            const pr = current.powerRound;
            if (!pr) return;

            const holder = pr.kind === "heaven" ? current.heavenHolder : current.thumbHolder;
            const allowed = requestedBy === current.host || (holder && requestedBy === holder);
            if (!allowed) return;

            const next = clearPowerHost(current);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        if (msg.type === "WATERFALL_START") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const next = startWaterfallHost(current, msg.requestedBy as string);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        if (msg.type === "QM_CAUGHT") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const next = qmCaughtHost(current, msg.requestedBy as string, msg.target as string);
            setState(next);
            send({ type: "STATE", data: next });
          }
          // show toast locally too
          if (msg.target) showToast(`${msg.target} answered the Question Master. (Tracked)`);
          return;
        }

        if (msg.type === "KING_ADD_RULE") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const next = kingAddRuleHost(current, msg.requestedBy as string, msg.text as string);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        if (msg.type === "KING_REMOVE_RULE") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const next = kingRemoveRuleHost(current, msg.requestedBy as string, msg.ruleId as string);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        if (msg.type === "UPDATE") {
          setState((s) => {
            const n = clone(s);
            ensurePlayer(n, msg.id);
            Object.assign(n.players[msg.id], msg.patch);
            return n;
          });
        }
      });

      room.on(RoomEvent.Disconnected, () => setConnected(false));

      await room.connect(data.url, data.token);
      setConnected(true);

      const current = stateRef.current;
      const next = clone(current);
      ensurePlayer(next, identity);

      if (!next.host) {
        next.host = identity;
        next.deck = shuffle(buildDeck());
        next.turn = identity;
      } else {
        if (!next.turn) next.turn = next.host;
      }

      setState(next);
      await send({ type: "STATE", data: next });

      try {
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        await attachLocalTracks(room, identity);
      } catch (e: any) {
        setErrMsg(`Camera/mic blocked: ${e?.message || e}`);
      }
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      setConnected(false);
      if (roomRef.current) {
        try {
          roomRef.current.disconnect();
        } catch {}
      }
      roomRef.current = null;
    } finally {
      setJoining(false);
    }
  }

  function disconnect() {
    setErrMsg("");
    const r = roomRef.current;
    if (r) {
      try {
        r.disconnect();
      } catch {}
    }
    roomRef.current = null;

    setState(clone(emptyState));
    setConnected(false);
  }

  /* =========================
     WATERFALL TICK (host only)
  ========================= */

  useEffect(() => {
    if (!connected) return;
    if (state.host !== me.current) return;

    const i = setInterval(() => {
      const current = stateRef.current;
      const next = tickWaterfallHost(current);
      if (next !== current) {
        setState(next);
        send({ type: "STATE", data: next });
      }
    }, 250);

    return () => clearInterval(i);
  }, [connected, state.host]);

  /* =========================
     UI / ORDERING / LAYOUT
  ========================= */

  const orderedPlayers = useMemo(() => {
    const mine = me.current ? [me.current] : [];
    const others = Object.keys(state.players)
      .filter((id) => id && id !== me.current)
      .sort((a, b) => a.localeCompare(b));
    return [...mine, ...others].slice(0, 6);
  }, [state.players]);

  const slotIds = useMemo(() => {
    const filled = [...orderedPlayers];
    while (filled.length < 6) filled.push(`__EMPTY__${filled.length + 1}`);
    return filled.slice(0, 6);
  }, [orderedPlayers]);

  const effectiveCount = Math.min(6, Math.max(1, orderedPlayers.length || 1));
  const layout = computeVideoLayout(effectiveCount);

  const ruleText = useMemo(() => ruleForCard(state.currentCard), [state.currentCard]);
  const turnLabel = state.turn || state.host || "—";

  function badgeRowForPlayer(id: string) {
    const b: string[] = [];
    if (state.heavenHolder === id) b.push("☁️");
    if (state.thumbHolder === id) b.push("👍");
    if (state.qmHolder === id) b.push("❓");
    if (state.kingHolder === id) b.push("👑");
    return b.join(" ");
  }

  const pr = state.powerRound;
  const prActive = !!pr?.active;

  const iCanTap =
    prActive && me.current && pr!.eligible.includes(me.current) && !pr!.tapped.includes(me.current);

  const showPowerStrip = !!state.heavenHolder || !!state.thumbHolder || !!state.powerRound;

  const canStartHeaven = canStartPower(state, "heaven", me.current);
  const canStartThumb = canStartPower(state, "thumb", me.current);

  const wf = state.waterfall;
  const deckLocked = isDeckLocked(state);
  const isAce = parseCard(state.currentCard).rank === "A";

  const wfCountdown = useMemo(() => {
    if (!wf || wf.phase !== "active" || !wf.startedAt) return null;
    const elapsed = (Date.now() - wf.startedAt) / 1000;
    const left = Math.max(0, wf.durationSec - elapsed);
    return Math.ceil(left);
  }, [wf, state.waterfall?.startedAt, state.waterfall?.durationSec]);

  const iAmQm = state.qmHolder === me.current;
  const iAmKing = state.kingHolder === me.current;

  function CardFace({ card }: { card: string | null }) {
    const { rank: rnk, suit: sut } = parseCard(card);
    const red = isRedSuit(sut);

    const ink = red ? "rgba(239,68,68,0.95)" : "rgba(2,6,23,0.9)";
    const ghost = red ? "rgba(239,68,68,0.20)" : "rgba(2,6,23,0.12)";

    return (
      <div className="bigCardB" aria-label="current card">
        <div className="cornerTL">
          <div className="cornerRank" style={{ color: ink }}>
            {rnk}
          </div>
          <div className="cornerSuit" style={{ color: ink }}>
            {sut || " "}
          </div>
        </div>

        <div className="centerSuit" style={{ color: ghost }}>
          {sut || " "}
        </div>

        <div className="cornerBR">
          <div className="cornerRank" style={{ color: ink }}>
            {rnk}
          </div>
          <div className="cornerSuit" style={{ color: ink }}>
            {sut || " "}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="appB">
      {/* tight extra CSS so turn highlight + compact actions work even if CSS shifts */}
      <style jsx global>{`
        .turnActiveB {
          box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.55), 0 0 0 6px rgba(34, 197, 94, 0.14);
          border-color: rgba(34, 197, 94, 0.35) !important;
        }

        .powerPillB {
          position: absolute;
          left: 10px;
          top: 10px;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 1000;
          background: rgba(2, 6, 23, 0.5);
          border: 1px solid rgba(148, 163, 184, 0.16);
          color: rgba(226, 232, 240, 0.95);
          max-width: calc(100% - 20px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .powerStripB {
          margin-top: 10px;
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .pwrBtnB {
          flex: 1 1 auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(2, 6, 23, 0.18);
          color: rgba(226, 232, 240, 0.95);
          font-weight: 1000;
          cursor: pointer;
          min-width: 0;
        }
        .pwrBtnB:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .pwrL {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .pwrIcon {
          font-size: 16px;
          line-height: 1;
        }
        .pwrText {
          display: grid;
          gap: 2px;
          min-width: 0;
        }
        .pwrTop {
          font-size: 12px;
          letter-spacing: 0.08em;
          opacity: 0.9;
          white-space: nowrap;
        }
        .pwrSub {
          font-size: 12px;
          font-weight: 900;
          opacity: 0.75;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pwrAction {
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 1100;
          letter-spacing: 0.06em;
          border: 1px solid rgba(34, 197, 94, 0.22);
          background: rgba(34, 197, 94, 0.12);
          white-space: nowrap;
        }
        .pwrTap {
          border-color: rgba(248, 113, 113, 0.22);
          background: rgba(248, 113, 113, 0.12);
        }
        .pwrClearB {
          flex: 0 0 auto;
          padding: 10px 12px;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(148, 163, 184, 0.12);
          color: rgba(226, 232, 240, 0.95);
          font-weight: 1000;
          cursor: pointer;
          white-space: nowrap;
        }

        .miniActionsB {
          margin-top: 10px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        .miniBtnB {
          border: 1px solid rgba(148, 163, 184, 0.16);
          background: rgba(2, 6, 23, 0.2);
          color: rgba(226, 232, 240, 0.95);
          border-radius: 14px;
          padding: 10px 12px;
          font-weight: 1000;
          cursor: pointer;
          white-space: nowrap;
        }
        .miniBtnB:disabled {
          opacity: 0.55;
          cursor: default;
        }

        .toastB {
          position: fixed;
          left: 50%;
          bottom: 18px;
          transform: translateX(-50%);
          z-index: 60;
          background: rgba(15, 23, 42, 0.85);
          border: 1px solid rgba(148, 163, 184, 0.18);
          color: rgba(226, 232, 240, 0.95);
          padding: 10px 14px;
          border-radius: 999px;
          font-weight: 1000;
          font-size: 12px;
          backdrop-filter: blur(10px);
          max-width: min(520px, calc(100% - 20px));
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .rulesMiniB {
          margin-top: 10px;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(2, 6, 23, 0.18);
          overflow: hidden;
        }
        .rulesMiniHeadB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.1);
        }
        .rulesMiniTitleB {
          font-weight: 1100;
          font-size: 12px;
          letter-spacing: 0.06em;
          opacity: 0.9;
        }
        .rulesMiniListB {
          display: grid;
        }
        .rulesMiniRowB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.08);
        }
        .rulesMiniRowB:last-child {
          border-bottom: 0;
        }
        .rulesMiniTextB {
          min-width: 0;
          font-size: 12px;
          font-weight: 1000;
          opacity: 0.95;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .rulesMiniMetaB {
          font-size: 11px;
          font-weight: 900;
          opacity: 0.7;
          white-space: nowrap;
        }
        .rulesMiniXBtnB {
          width: 34px;
          height: 34px;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(2, 6, 23, 0.22);
          color: rgba(226, 232, 240, 0.95);
          font-weight: 1100;
          cursor: pointer;
          flex: 0 0 auto;
        }
      `}</style>

      {toast ? <div className="toastB">{toast}</div> : null}

      <div className="topbarB">
        <div className="brandB">
          <img className="logoImgB" src="/kylesadick-logo.png" alt="KylesADick logo" />
          <div style={{ minWidth: 0 }}>
            <div className="titleOnlyB">KAD-KINGS</div>
          </div>
        </div>

        <div className="rowB" style={{ justifyContent: "flex-end" }}>
          <button className="fsBtnB" onClick={toggleFullscreen}>
            {isFs ? "Exit" : "Fullscreen"}
          </button>

          <div className="statusB">
            <span
              className="dotB"
              style={{
                background: connected ? "rgba(34,197,94,0.9)" : "rgba(148,163,184,0.9)",
              }}
            />
            {connected ? "Connected" : "Not connected"}
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="cardB joinCardB">
          <div className="fieldB">
            <div>Room</div>
            <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="kad" />
          </div>

          <div className="fieldB">
            <div>Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="your name" />
          </div>

          <div className="rowB">
            <button className="btnB btnPrimaryB" onClick={connect} disabled={joining}>
              {joining ? "Joining..." : "Join"}
            </button>
          </div>

          {errMsg ? (
            <div className="noteB" style={{ color: "rgba(248,113,113,0.95)", fontWeight: 900 }}>
              {errMsg}
            </div>
          ) : (
            <div className="noteB">If Join does nothing, the error will show here.</div>
          )}
        </div>
      ) : (
        <div className="shellB">
          <div className="cardB videoCardB">
            <div className="cardHeadB">
              <h2>Players</h2>
              <div className="rowB" style={{ justifyContent: "flex-end" }}>
                <div className="statusB" style={{ padding: "8px 10px" }}>
                  Host: <b style={{ marginLeft: 6 }}>{state.host || "—"}</b>
                </div>
                <button className="btnB btnDangerB btnTinyB" onClick={disconnect}>
                  Leave
                </button>
              </div>
            </div>

            {errMsg ? (
              <div className="noteB" style={{ color: "rgba(248,113,113,0.95)", fontWeight: 900 }}>
                {errMsg}
              </div>
            ) : null}

            <div className="videoGridB" data-layout={layout}>
              {slotIds.map((id) => {
                const isEmpty = id.startsWith("__EMPTY__");
                if (isEmpty) {
                  return (
                    <div key={id} className="vTile vEmpty">
                      <div className="vPlus">+</div>
                      <div className="vEmptyTag">Empty</div>
                    </div>
                  );
                }

                const isMe = id === me.current;
                const badges = badgeRowForPlayer(id);
                const isTurn = !!state.turn && id === state.turn;

                return (
                  <div key={id} className={`vTile ${isTurn ? "turnActiveB" : ""}`} data-id={id}>
                    <video
                      data-video-for={id}
                      autoPlay
                      playsInline
                      muted={isMe}
                      // @ts-ignore
                      webkit-playsinline="true"
                    />
                    {badges ? <div className="powerPillB">{badges}</div> : null}
                    <div className="vTag">{id}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bottomBarB">
            <div className="cardB deckMiniB">
              <button className="drawComboB" onClick={draw} disabled={deckLocked}>
                <div className="cardSquareB">
                  <CardFace card={state.currentCard} />
                </div>

                <div className="drawTextB">
                  <div className="drawTitleB">TURN</div>
                  <div className="turnLineB">{turnLabel}</div>
                  <div className="ruleLineB">{ruleText}</div>
                  <div className="tapLineB">
                    {deckLocked
                      ? "Deck locked"
                      : state.host === me.current
                      ? "Tap to draw"
                      : "Tap to request draw"}
                  </div>
                </div>

                <div className="drawMetaB">
                  <div className="metaPillB">🃏 {state.deck.length}</div>
                  <div className="metaPillB">{state.host === me.current ? "HOST" : "GUEST"}</div>
                </div>
              </button>

              {/* ACE WATERFALL PANEL (only when Ace is drawn) */}
              {wf ? (
                <div className="miniActionsB">
                  <div className="miniBtnB" style={{ cursor: "default" }}>
                    WATERFALL · {wf.direction.toUpperCase()} · {wf.durationSec}s (random)
                    {wf.phase === "active" && typeof wfCountdown === "number" ? ` · ${wfCountdown}s left` : ""}
                  </div>
                  <button
                    className="miniBtnB"
                    onClick={startWaterfall}
                    disabled={wf.drawer !== me.current || wf.phase !== "pending"}
                    title="Only the Ace drawer can start Waterfall"
                  >
                    READY / START
                  </button>
                </div>
              ) : null}

              {/* POWER STRIP (Heaven + Thumb) */}
              {showPowerStrip ? (
                <div className="powerStripB">
                  <button
                    className="pwrBtnB"
                    onClick={() => {
                      if (prActive && pr?.kind === "heaven") tapPower("heaven");
                      else startPower("heaven");
                    }}
                    disabled={prActive ? !(pr?.kind === "heaven" && iCanTap) : !canStartHeaven}
                    title="Heaven: holder starts anytime; last tap loses"
                  >
                    <div className="pwrL">
                      <div className="pwrIcon">☁️</div>
                      <div className="pwrText">
                        <div className="pwrTop">HEAVEN</div>
                        <div className="pwrSub">
                          Holder: {state.heavenHolder || "—"}
                          {pr?.kind === "heaven" && pr.active ? ` · ${pr.tapped.length}/${pr.eligible.length}` : ""}
                          {pr?.kind === "heaven" && !pr.active && pr.loser ? ` · Loser: ${pr.loser}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className={`pwrAction ${prActive && pr?.kind === "heaven" ? "pwrTap" : ""}`}>
                      {prActive && pr?.kind === "heaven" ? "TAP" : "START"}
                    </div>
                  </button>

                  <button
                    className="pwrBtnB"
                    onClick={() => {
                      if (prActive && pr?.kind === "thumb") tapPower("thumb");
                      else startPower("thumb");
                    }}
                    disabled={prActive ? !(pr?.kind === "thumb" && iCanTap) : !canStartThumb}
                    title="Thumb: holder starts anytime; last tap loses"
                  >
                    <div className="pwrL">
                      <div className="pwrIcon">👍</div>
                      <div className="pwrText">
                        <div className="pwrTop">THUMB</div>
                        <div className="pwrSub">
                          Holder: {state.thumbHolder || "—"}
                          {pr?.kind === "thumb" && pr.active ? ` · ${pr.tapped.length}/${pr.eligible.length}` : ""}
                          {pr?.kind === "thumb" && !pr.active && pr.loser ? ` · Loser: ${pr.loser}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className={`pwrAction ${prActive && pr?.kind === "thumb" ? "pwrTap" : ""}`}>
                      {prActive && pr?.kind === "thumb" ? "TAP" : "START"}
                    </div>
                  </button>

                  {state.powerRound ? (
                    <button className="pwrClearB" onClick={clearPower} title="Clear current/last power round">
                      CLEAR
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* QM + KING actions (tight) */}
              <div className="miniActionsB">
                <button className="miniBtnB" onClick={() => setQmOpen(true)} disabled={!iAmQm} title="Question Master">
                  ❓ QM
                </button>
                <button
                  className="miniBtnB"
                  onClick={() => setKingOpen(true)}
                  disabled={!iAmKing}
                  title="King: add a rule"
                >
                  👑 Add Rule
                </button>
                {state.qmHolder ? (
                  <div className="miniBtnB" style={{ cursor: "default" }}>
                    QM Holder: <b style={{ marginLeft: 6 }}>{state.qmHolder}</b>
                  </div>
                ) : null}
                {state.kingHolder ? (
                  <div className="miniBtnB" style={{ cursor: "default" }}>
                    King Holder: <b style={{ marginLeft: 6 }}>{state.kingHolder}</b>
                  </div>
                ) : null}
              </div>

              {/* KING RULES LIST */}
              {state.kingRules && state.kingRules.length ? (
                <div className="rulesMiniB">
                  <div className="rulesMiniHeadB">
                    <div className="rulesMiniTitleB">ACTIVE RULES</div>
                    <div className="rulesMiniTitleB" style={{ opacity: 0.7 }}>
                      {state.kingRules.length}
                    </div>
                  </div>
                  <div className="rulesMiniListB">
                    {state.kingRules.slice(0, 10).map((r) => {
                      const canRemove = me.current === state.host || me.current === r.by;
                      return (
                        <div key={r.id} className="rulesMiniRowB">
                          <div style={{ minWidth: 0 }}>
                            <div className="rulesMiniTextB">{r.text}</div>
                            <div className="rulesMiniMetaB">by {r.by}</div>
                          </div>
                          {canRemove ? (
                            <button className="rulesMiniXBtnB" onClick={() => kingRemoveRule(r.id)} title="Remove rule">
                              ×
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="cardB statsMiniB">
              <div className="yourDrinksRowB">
                <div>
                  <div className="labelMiniB">Your drinks</div>
                  <div className="drinkNumB">{state.players[me.current]?.drinks ?? 0}</div>
                </div>
                <div className="btnGroupB">
                  <button className="btnB btnTinyB" onClick={() => changeDrink(-1)}>
                    -1
                  </button>
                  <button className="btnB btnPrimaryB btnTinyB" onClick={() => changeDrink(1)}>
                    +1
                  </button>
                </div>
              </div>

              <div className="playersMiniListB">
                {orderedPlayers.map((id) => {
                  const p = state.players[id];
                  if (!p) return null;
                  const badges = badgeRowForPlayer(id);

                  return (
                    <div key={p.name} className="pRowB">
                      <div className="pNameB">
                        {p.name} {badges ? <span className="pBadgesB"> {badges}</span> : null}
                      </div>
                      <div className="pMetaB">
                        🍺 {p.drinks} · 🃏 {p.cardsDrawn} · ❓ {p.qmCaught} · ⚡ {p.powerLosses}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* QM MODAL */}
      {qmOpen ? (
        <div className="overlayB" onClick={() => setQmOpen(false)}>
          <div className="rulesModalB" onClick={(e) => e.stopPropagation()}>
            <div className="rulesModalTopB">
              <div className="rulesModalTitleB">❓ Question Master</div>
              <button className="ruleXBtnB" onClick={() => setQmOpen(false)}>
                ×
              </button>
            </div>

            <div className="rulesModalNoteB">
              Select who answered your question. (Tracked only — no auto drinks.)
            </div>

            <div className="rulesGridB">
              {orderedPlayers
                .filter((id) => id && id !== me.current)
                .map((id) => (
                  <button
                    key={id}
                    className="rulePickBtnB"
                    onClick={() => {
                      qmCaught(id);
                      setQmOpen(false);
                    }}
                    disabled={!iAmQm}
                  >
                    {id}
                  </button>
                ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* KING ADD RULE MODAL */}
      {kingOpen ? (
        <div className="overlayB" onClick={() => setKingOpen(false)}>
          <div className="rulesModalB" onClick={(e) => e.stopPropagation()}>
            <div className="rulesModalTopB">
              <div className="rulesModalTitleB">👑 Add a Rule</div>
              <button className="ruleXBtnB" onClick={() => setKingOpen(false)}>
                ×
              </button>
            </div>

            <div className="rulesModalNoteB">Only the current King can add rules. Keep it short.</div>

            <div className="fieldB">
              <div>Rule text</div>
              <input
                value={kingText}
                onChange={(e) => setKingText(e.target.value)}
                placeholder="e.g., No saying 'drink' — say 'sip' instead"
              />
            </div>

            <div className="rowB" style={{ justifyContent: "flex-end" }}>
              <button className="btnB btnPrimaryB" onClick={kingAddRule} disabled={!iAmKing || !kingText.trim()}>
                Add
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <AttachLocalOnConnect connected={connected} me={me} roomRef={roomRef} attachLocalTracks={attachLocalTracks} />
    </div>
  );
}

/* =========================
   Helper: attach local video after mount
========================= */

function AttachLocalOnConnect({
  connected,
  me,
  roomRef,
  attachLocalTracks,
}: {
  connected: boolean;
  me: React.MutableRefObject<string>;
  roomRef: React.MutableRefObject<Room | null>;
  attachLocalTracks: (room: Room, identity: string) => Promise<void>;
}) {
  useEffect(() => {
    if (!connected) return;
    const room = roomRef.current;
    const identity = me.current;
    if (!room || !identity) return;

    const t = setTimeout(() => {
      attachLocalTracks(room, identity).catch(() => {});
    }, 150);

    return () => clearTimeout(t);
  }, [connected, me, roomRef, attachLocalTracks]);

  return null;
     }
