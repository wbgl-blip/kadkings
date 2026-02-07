/* app/page.tsx */
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";

/* =========================
   TYPES
========================= */

type PlayerStats = {
  name: string;
  drinks: number;
  cardsDrawn: number;
};

type WaterfallState = {
  status: "idle" | "pending" | "running" | "ended";
  drawer: string | null;
  seconds: number; // random 5-20 each Ace
  startedAt: number | null;
  endsAt: number | null;
};

type HeavenState = {
  status: "idle" | "running" | "ended";
  drawer: string | null; // who drew 7 (only they can start)
  startedAt: number | null;
  endsAt: number | null; // safety auto-end so it can't get stuck
  participants: string[]; // snapshot at start
  taps: string[]; // order of taps (first -> last)
  loser: string | null; // last to react
};

type GameState = {
  host: string | null;
  deck: string[];
  currentCard: string | null;

  turn: string | null;
  lastDrawBy: string | null;

  players: Record<string, PlayerStats>;

  // Power status holders (badges)
  heavenHolder: string | null; // 7
  thumbHolder: string | null; // J
  qmHolder: string | null; // Q
  kingHolder: string | null; // K

  // Locks / minis
  deckLocked: boolean;

  // Power modes
  waterfall: WaterfallState;
  heaven: HeavenState;
};

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW"; requestedBy?: string }
  | { type: "UPDATE"; id: string; patch: Partial<PlayerStats> }
  | {
      type: "ACTION";
      action:
        | "WATERFALL_START"
        | "WATERFALL_END"
        | "HEAVEN_START"
        | "HEAVEN_TAP"
        | "HEAVEN_END";
      by: string;
    };

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

function nowMs() {
  return Date.now();
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

  switch (rank) {
    case "A":
      return "Ace = Waterfall (drawer starts when ready).";
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
      return "7 = Heaven (drawer starts; last to react drinks).";
    case "8":
      return "8 = Mate (one-way chain).";
    case "9":
      return "9 = Rhyme (vote if needed).";
    case "10":
      return "10 = Categories (go around).";
    case "J":
      return "Jack = Thumbmaster (power; last loses).";
    case "Q":
      return "Queen = Question Master (gotcha).";
    case "K":
      return "King = Make a rule (stays active).";
    default:
      return "House rules.";
  }
}

function msToSecondsLeft(endsAt: number | null) {
  if (!endsAt) return 0;
  const left = endsAt - nowMs();
  return Math.max(0, Math.ceil(left / 1000));
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

  // host-only timers so rounds can end without server
  const waterfallEndTimer = useRef<any>(null);
  const heavenEndTimer = useRef<any>(null);

  const initialState: GameState = {
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

    deckLocked: false,

    waterfall: { status: "idle", drawer: null, seconds: 0, startedAt: null, endsAt: null },
    heaven: { status: "idle", drawer: null, startedAt: null, endsAt: null, participants: [], taps: [], loser: null },
  };

  const stateRef = useRef<GameState>(clone(initialState));

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState("");

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [isFs, setIsFs] = useState(false);

  const [state, setState] = useState<GameState>(clone(initialState));

  // tick so countdown labels update
  const [tick, setTick] = useState(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);

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
    if (!gs.players[id]) {
      gs.players[id] = { name: id, drinks: 0, cardsDrawn: 0 };
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

  function clearTimers() {
    if (waterfallEndTimer.current) {
      clearTimeout(waterfallEndTimer.current);
      waterfallEndTimer.current = null;
    }
    if (heavenEndTimer.current) {
      clearTimeout(heavenEndTimer.current);
      heavenEndTimer.current = null;
    }
  }

  function isHost() {
    return stateRef.current.host === me.current && !!me.current;
  }

  function hostBroadcast(next: GameState) {
    setState(next);
    send({ type: "STATE", data: next });
  }

  function currentRank() {
    return parseCard(stateRef.current.currentCard).rank;
  }

  function canDrawerStartHeaven(gs: GameState) {
    const r = parseCard(gs.currentCard).rank;
    return r === "7" && gs.heaven.drawer && gs.heaven.drawer === me.current && gs.heaven.status !== "running";
  }

  function canDrawerStartWaterfall(gs: GameState) {
    const r = parseCard(gs.currentCard).rank;
    return r === "A" && gs.waterfall.drawer && gs.waterfall.drawer === me.current && gs.waterfall.status !== "running";
  }

  function scheduleWaterfallEnd(endsAt: number) {
    if (!isHost()) return;
    if (waterfallEndTimer.current) clearTimeout(waterfallEndTimer.current);
    const delay = Math.max(0, endsAt - nowMs());
    waterfallEndTimer.current = setTimeout(() => {
      const gs = stateRef.current;
      if (parseCard(gs.currentCard).rank !== "A") return;
      if (gs.waterfall.status !== "running") return;
      doWaterfallEnd(gs, "timer");
    }, delay + 50);
  }

  function scheduleHeavenEnd(endsAt: number) {
    if (!isHost()) return;
    if (heavenEndTimer.current) clearTimeout(heavenEndTimer.current);
    const delay = Math.max(0, endsAt - nowMs());
    heavenEndTimer.current = setTimeout(() => {
      const gs = stateRef.current;
      if (parseCard(gs.currentCard).rank !== "7") return;
      if (gs.heaven.status !== "running") return;
      doHeavenEnd(gs, "timeout");
    }, delay + 50);
  }

  function doWaterfallStart(gs: GameState) {
    if (!isHost()) return;
    const next = clone(gs);
    if (parseCard(next.currentCard).rank !== "A") return;
    if (next.waterfall.status === "running") return;

    next.deckLocked = true;
    next.waterfall.status = "running";
    next.waterfall.startedAt = nowMs();
    next.waterfall.endsAt = (next.waterfall.startedAt || nowMs()) + next.waterfall.seconds * 1000;

    // stay on drawer until round is over
    if (next.waterfall.drawer) next.turn = next.waterfall.drawer;

    hostBroadcast(next);

    if (next.waterfall.endsAt) scheduleWaterfallEnd(next.waterfall.endsAt);
  }

  function doWaterfallEnd(gs: GameState, _reason: "timer" | "host") {
    if (!isHost()) return;
    const next = clone(gs);
    if (parseCard(next.currentCard).rank !== "A") return;
    if (next.waterfall.status !== "running") return;

    next.waterfall.status = "ended";
    next.waterfall.endsAt = null;
    next.deckLocked = false;

    // AFTER round ends, advance turn
    next.turn = advanceTurn(next);

    hostBroadcast(next);
  }

  function doHeavenStart(gs: GameState) {
    if (!isHost()) return;
    const next = clone(gs);
    if (parseCard(next.currentCard).rank !== "7") return;
    if (next.heaven.status === "running") return;

    // drawer can start whenever (while 7 is the current card)
    if (!next.heaven.drawer) return;

    const participants = getTurnOrder(next);
    next.heaven.status = "running";
    next.heaven.startedAt = nowMs();
    next.heaven.endsAt = (next.heaven.startedAt || nowMs()) + 15000; // safety so it never gets stuck
    next.heaven.participants = participants;
    next.heaven.taps = [];
    next.heaven.loser = null;

    next.deckLocked = true;

    // stay on drawer until round is over
    next.turn = next.heaven.drawer;

    hostBroadcast(next);

    if (next.heaven.endsAt) scheduleHeavenEnd(next.heaven.endsAt);
  }

  function doHeavenTap(gs: GameState, who: string) {
    if (!isHost()) return;
    const next = clone(gs);
    if (parseCard(next.currentCard).rank !== "7") return;
    if (next.heaven.status !== "running") return;

    // only count taps from participants snapshot
    if (!next.heaven.participants.includes(who)) return;

    if (!next.heaven.taps.includes(who)) next.heaven.taps.push(who);

    hostBroadcast(next);

    // if everyone tapped, end immediately
    if (next.heaven.taps.length >= next.heaven.participants.length) {
      doHeavenEnd(next, "allTapped");
    }
  }

  function doHeavenEnd(gs: GameState, _reason: "allTapped" | "timeout" | "host") {
    if (!isHost()) return;
    const next = clone(gs);
    if (parseCard(next.currentCard).rank !== "7") return;
    if (next.heaven.status !== "running") return;

    // loser = last tapper if all tapped, otherwise first missing (still counts as "last to react")
    const participants = next.heaven.participants || [];
    const taps = next.heaven.taps || [];

    const missing = participants.filter((p) => !taps.includes(p));
    const loser =
      missing.length > 0 ? missing[missing.length - 1] : taps.length > 0 ? taps[taps.length - 1] : null;

    next.heaven.status = "ended";
    next.heaven.loser = loser;
    next.heaven.endsAt = null;

    next.deckLocked = false;

    // AFTER round ends, advance turn
    next.turn = advanceTurn(next);

    hostBroadcast(next);
  }

  async function draw() {
    const r = roomRef.current;
    if (!r) return;

    const current = stateRef.current;

    // lock: no drawing during power rounds
    if (current.deckLocked) return;

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

    // default: unlock unless a power round sets it
    next.deckLocked = false;

    // reset power states when new card is drawn
    next.waterfall = { status: "idle", drawer: null, seconds: 0, startedAt: null, endsAt: null };
    next.heaven = { status: "idle", drawer: null, startedAt: null, endsAt: null, participants: [], taps: [], loser: null };

    // badges (holders)
    if (rank === "7") next.heavenHolder = me.current;
    if (rank === "J") next.thumbHolder = me.current;
    if (rank === "Q") next.qmHolder = me.current;
    if (rank === "K") next.kingHolder = me.current;

    // POWER SETUP
    if (rank === "A") {
      // Ace creates a pending waterfall with random timer (drawer controls start)
      const seconds = randInt(5, 20);
      next.waterfall = { status: "pending", drawer: me.current, seconds, startedAt: null, endsAt: null };
      next.deckLocked = true; // no drawing while waiting
      next.turn = me.current; // stay on drawer until done
    }

    if (rank === "7") {
      // Heaven is not auto-started; drawer can start whenever while 7 is current card
      next.heaven = { status: "idle", drawer: me.current, startedAt: null, endsAt: null, participants: [], taps: [], loser: null };
      next.deckLocked = true; // no drawing until Heaven ends
      next.turn = me.current; // stay on drawer until done
    }

    // if not a lock card, advance turn normally after draw
    if (!next.deckLocked) {
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

  async function drawerStartWaterfall() {
    const gs = stateRef.current;
    if (parseCard(gs.currentCard).rank !== "A") return;
    if (!canDrawerStartWaterfall(gs)) return;

    // only host mutates state; drawer requests if not host
    if (!isHost()) {
      await send({ type: "ACTION", action: "WATERFALL_START", by: me.current });
      return;
    }

    doWaterfallStart(gs);
  }

  async function drawerStartHeaven() {
    const gs = stateRef.current;
    if (parseCard(gs.currentCard).rank !== "7") return;
    if (!canDrawerStartHeaven(gs)) return;

    if (!isHost()) {
      await send({ type: "ACTION", action: "HEAVEN_START", by: me.current });
      return;
    }

    doHeavenStart(gs);
  }

  async function heavenTap() {
    const gs = stateRef.current;
    if (parseCard(gs.currentCard).rank !== "7") return;
    if (gs.heaven.status !== "running") return;

    if (!isHost()) {
      await send({ type: "ACTION", action: "HEAVEN_TAP", by: me.current });
      return;
    }

    doHeavenTap(gs, me.current);
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
      if (track.kind === Track.Kind.Video) {
        attachTrackToIdentity(track, identity);
      }
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
      const res = await fetch(
        `/api/token?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(identity)}`
      );
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

        if (track.kind === Track.Kind.Video) {
          attachTrackToIdentity(track, participant.identity);
        }
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

          // if a holder leaves, clear holder
          if (n.heavenHolder === participant.identity) n.heavenHolder = null;
          if (n.thumbHolder === participant.identity) n.thumbHolder = null;
          if (n.qmHolder === participant.identity) n.qmHolder = null;
          if (n.kingHolder === participant.identity) n.kingHolder = null;

          // if running heaven, remove from participants/taps (host will still decide end)
          if (n.heaven.status === "running") {
            n.heaven.participants = (n.heaven.participants || []).filter((p) => p !== participant.identity);
            n.heaven.taps = (n.heaven.taps || []).filter((p) => p !== participant.identity);
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

            deckLocked: msg.data.deckLocked ?? false,

            waterfall: msg.data.waterfall ?? { status: "idle", drawer: null, seconds: 0, startedAt: null, endsAt: null },
            heaven:
              msg.data.heaven ??
              ({ status: "idle", drawer: null, startedAt: null, endsAt: null, participants: [], taps: [], loser: null } as HeavenState),
          };

          setState(incoming);

          // if I'm host and see a running round with endsAt, schedule local timer
          if (incoming.host === me.current) {
            if (incoming.waterfall.status === "running" && incoming.waterfall.endsAt) scheduleWaterfallEnd(incoming.waterfall.endsAt);
            if (incoming.heaven.status === "running" && incoming.heaven.endsAt) scheduleHeavenEnd(incoming.heaven.endsAt);
          }

          return;
        }

        if (msg.type === "DRAW") {
          const current = stateRef.current;
          if (roomRef.current && me.current && current.host === me.current) {
            draw();
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
          return;
        }

        if (msg.type === "ACTION") {
          const gs = stateRef.current;
          // only host applies actions
          if (!isHost()) return;

          if (msg.action === "WATERFALL_START") {
            // only drawer can start
            if (gs.waterfall.drawer && msg.by === gs.waterfall.drawer && parseCard(gs.currentCard).rank === "A") {
              doWaterfallStart(gs);
            }
            return;
          }

          if (msg.action === "HEAVEN_START") {
            if (gs.heaven.drawer && msg.by === gs.heaven.drawer && parseCard(gs.currentCard).rank === "7") {
              doHeavenStart(gs);
            }
            return;
          }

          if (msg.action === "HEAVEN_TAP") {
            doHeavenTap(gs, msg.by);
            return;
          }

          if (msg.action === "HEAVEN_END") {
            doHeavenEnd(gs, "host");
            return;
          }

          if (msg.action === "WATERFALL_END") {
            doWaterfallEnd(gs, "host");
            return;
          }

          return;
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
      });

      await room.connect(data.url, data.token);

      setConnected(true);

      // init / merge state
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
    clearTimers();

    const r = roomRef.current;
    if (r) {
      try {
        r.disconnect();
      } catch {}
    }
    roomRef.current = null;

    setState(clone(initialState));
    setConnected(false);
  }

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

  const deckCountLabel = state.deck.length;

  function badgeRowForPlayer(id: string) {
    const b: string[] = [];
    if (state.heavenHolder === id) b.push("☁️");
    if (state.thumbHolder === id) b.push("👍");
    if (state.qmHolder === id) b.push("❓");
    if (state.kingHolder === id) b.push("👑");
    return b.join(" ");
  }

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

  const isDeckLocked = state.deckLocked;

  const showWaterfallPanel = parseCard(state.currentCard).rank === "A";
  const showHeavenPanel = parseCard(state.currentCard).rank === "7";

  const wfSecondsLeft = msToSecondsLeft(state.waterfall.endsAt);
  const hvSecondsLeft = msToSecondsLeft(state.heaven.endsAt);

  const canStartWaterfall = showWaterfallPanel && canDrawerStartWaterfall(state);
  const canStartHeaven = showHeavenPanel && canDrawerStartHeaven(state);

  const heavenIsRunning = showHeavenPanel && state.heaven.status === "running";
  const heavenTapDisabled =
    !heavenIsRunning ||
    !state.heaven.participants.includes(me.current) ||
    state.heaven.taps.includes(me.current);

  const heavenTapLabel = heavenTapDisabled
    ? state.heaven.taps.includes(me.current)
      ? "TAPPED"
      : "WAITING"
    : "TAP (HEAVEN)";

  return (
    <div className="appB">
      <style jsx global>{`
        .logoImgB {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          object-fit: cover;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(2, 6, 23, 0.35);
          flex: 0 0 auto;
        }
        .fsBtnB {
          border: 0;
          border-radius: 14px;
          padding: 8px 10px;
          font-weight: 900;
          color: rgba(226, 232, 240, 0.95);
          background: rgba(148, 163, 184, 0.14);
          border: 1px solid rgba(148, 163, 184, 0.16);
          cursor: pointer;
          white-space: nowrap;
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
        .turnGlowB {
          outline: 2px solid rgba(34, 197, 94, 0.28);
          outline-offset: -2px;
          box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.08);
        }
        .lockPillB {
          padding: 8px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 1000;
          background: rgba(2, 6, 23, 0.35);
          border: 1px solid rgba(148, 163, 184, 0.16);
          opacity: 0.95;
          white-space: nowrap;
        }
        .powerPanelB {
          margin-top: 10px;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(2, 6, 23, 0.18);
          padding: 10px;
          display: grid;
          gap: 10px;
        }
        .powerLineB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          font-weight: 1000;
          font-size: 12px;
          opacity: 0.95;
        }
        .powerBtnB {
          width: 100%;
          border: 0;
          border-radius: 18px;
          padding: 16px 14px;
          font-weight: 1100;
          font-size: 18px;
          letter-spacing: 0.08em;
          color: rgba(226, 232, 240, 0.95);
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.24), rgba(2, 6, 23, 0.35));
          border: 1px solid rgba(34, 197, 94, 0.22);
          cursor: pointer;
        }
        .powerBtnB:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .dangerBtnB {
          background: linear-gradient(180deg, rgba(248, 113, 113, 0.28), rgba(2, 6, 23, 0.35));
          border: 1px solid rgba(248, 113, 113, 0.22);
        }
      `}</style>

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
                const isTurn = id === turnLabel;

                return (
                  <div key={id} className={`vTile ${isTurn ? "turnGlowB" : ""}`} data-id={id}>
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
              <button className="drawComboB" onClick={draw} disabled={isDeckLocked}>
                <div className="cardSquareB">
                  <CardFace card={state.currentCard} />
                </div>

                <div className="drawTextB">
                  <div className="drawTitleB">TURN</div>
                  <div className="turnLineB">{turnLabel}</div>
                  <div className="ruleLineB">{ruleText}</div>
                  <div className="tapLineB">
                    {isDeckLocked
                      ? "Deck locked"
                      : state.host === me.current
                      ? "Tap to draw"
                      : "Tap to request draw"}
                  </div>
                </div>

                <div className="drawMetaB">
                  <div className="metaPillB">🃏 {deckCountLabel}</div>
                  <div className="metaPillB">{state.host === me.current ? "HOST" : "GUEST"}</div>
                </div>
              </button>

              {/* POWER: ACE (drawer starts) */}
              {showWaterfallPanel ? (
                <div className="powerPanelB">
                  <div className="powerLineB">
                    <div>
                      WATERFALL · {state.waterfall.seconds ? `${state.waterfall.seconds}s` : "—"} (random)
                    </div>
                    <div className="lockPillB">{state.waterfall.status === "running" ? `⏳ ${wfSecondsLeft}s` : "🔒"}</div>
                  </div>

                  <div className="noteB" style={{ opacity: 0.85, fontWeight: 900 }}>
                    Drawer starts when ready. No draws until it ends. Direction clockwise.
                  </div>

                  <button className="powerBtnB" onClick={drawerStartWaterfall} disabled={!canStartWaterfall}>
                    READY / START WATERFALL
                  </button>
                </div>
              ) : null}

              {/* POWER: HEAVEN (drawer starts; last to react drinks) */}
              {showHeavenPanel ? (
                <div className="powerPanelB">
                  <div className="powerLineB">
                    <div>HEAVEN</div>
                    <div className="lockPillB">
                      {state.heaven.status === "running" ? `⏳ ${hvSecondsLeft}s` : "🔒"}
                    </div>
                  </div>

                  <div className="noteB" style={{ opacity: 0.85, fontWeight: 900 }}>
                    Drawer can start whenever. Everyone taps once. Last to react drinks.
                    {state.heaven.loser ? ` Loser: ${state.heaven.loser}` : ""}
                  </div>

                  {state.heaven.status !== "running" ? (
                    <button className="powerBtnB" onClick={drawerStartHeaven} disabled={!canStartHeaven}>
                      START HEAVEN
                    </button>
                  ) : (
                    <button className="powerBtnB dangerBtnB" onClick={heavenTap} disabled={heavenTapDisabled}>
                      {heavenTapLabel}
                    </button>
                  )}

                  {state.heaven.status === "running" ? (
                    <div className="noteB" style={{ opacity: 0.85, fontWeight: 900 }}>
                      Taps: {state.heaven.taps.length}/{state.heaven.participants.length}
                    </div>
                  ) : null}
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
                        🍺 {p.drinks} · 🃏 {p.cardsDrawn}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

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
