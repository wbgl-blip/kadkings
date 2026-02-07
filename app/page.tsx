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

type WaterfallPhase = "idle" | "ready" | "running";

type WaterfallState = {
  phase: WaterfallPhase;
  drawer: string | null; // the player who drew the Ace
  durationSec: number; // random 5..20
  startAtMs: number | null; // epoch ms (host time)
  endAtMs: number | null; // epoch ms (host time)
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

  // ✅ Waterfall (Ace)
  waterfall: WaterfallState;

  // ✅ hard lock while waterfall is ready/running
  deckLocked: boolean;
};

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW"; requestedBy?: string }
  | { type: "UPDATE"; id: string; patch: Partial<PlayerStats> }
  | { type: "WF_START_REQ"; requestedBy: string };

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
      return "Ace = Waterfall (drawer starts). Everyone starts together. Random 5–20s. Clockwise.";
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
      return "7 = Heaven (☁️ holder; last loses).";
    case "8":
      return "8 = Mate (one-way chain).";
    case "9":
      return "9 = Rhyme (vote if needed).";
    case "10":
      return "10 = Categories (go around).";
    case "J":
      return "Jack = Thumbmaster (👍 holder; last loses).";
    case "Q":
      return "Queen = Question Master (❓ holder; gotcha).";
    case "K":
      return "King = Make a rule (👑 holder; stays active).";
    default:
      return "House rules.";
  }
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeDefaultState(): GameState {
  return {
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

    waterfall: {
      phase: "idle",
      drawer: null,
      durationSec: 0,
      startAtMs: null,
      endAtMs: null,
    },

    deckLocked: false,
  };
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

  const stateRef = useRef<GameState>(makeDefaultState());

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState("");

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [isFs, setIsFs] = useState(false);

  const [state, setState] = useState<GameState>(makeDefaultState());

  // local ticking for countdown display (does not change state)
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(t);
  }, [connected]);

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

  async function broadcastState(next: GameState) {
    setState(next);
    await send({ type: "STATE", data: next });
  }

  /* =========================
     GAME LOGIC
  ========================= */

  function ensurePlayer(gs: GameState, id: string) {
    if (!id) return;
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

  function advanceTurnFrom(gs: GameState, fromId: string | null): string | null {
    const order = getTurnOrder(gs);
    if (!order.length) return gs.host;

    const cur = fromId && order.includes(fromId) ? fromId : order[0];
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length];
    return next || order[0] || gs.host;
  }

  function isHostMe() {
    return stateRef.current.host === me.current && !!me.current;
  }

  function isDeckLocked(gs: GameState) {
    return !!gs.deckLocked || gs.waterfall.phase !== "idle";
  }

  async function draw() {
    const r = roomRef.current;
    if (!r) return;

    const current = stateRef.current;

    // ✅ hard stop draw while locked
    if (isDeckLocked(current)) return;

    // host draws; guests request draw
    if (current.host !== me.current) {
      await send({ type: "DRAW", requestedBy: me.current });
      return;
    }

    const next = clone(current);

    if (!next.deck.length) {
      next.deck = shuffle(buildDeck());
    }

    const card = next.deck.shift() || null;
    next.currentCard = card;

    ensurePlayer(next, me.current);
    next.players[me.current].cardsDrawn++;
    next.lastDrawBy = me.current;

    const { rank } = parseCard(card);

    // ✅ set badge holders
    if (rank === "7") next.heavenHolder = me.current;
    if (rank === "J") next.thumbHolder = me.current;
    if (rank === "Q") next.qmHolder = me.current;
    if (rank === "K") next.kingHolder = me.current;

    // ✅ ACE: enter Waterfall READY, lock deck, do NOT advance turn
    if (rank === "A") {
      const dur = randInt(5, 20);
      next.waterfall = {
        phase: "ready",
        drawer: me.current,
        durationSec: dur,
        startAtMs: null,
        endAtMs: null,
      };
      next.deckLocked = true;
      next.turn = me.current; // stay on drawer until finished
      await broadcastState(next);
      return;
    }

    // normal: advance turn after draw
    next.turn = advanceTurnFrom(next, me.current);

    await broadcastState(next);
  }

  // ✅ drawer (Ace) starts waterfall (HOST authoritative)
  async function startWaterfall() {
    const current = stateRef.current;
    if (!current.currentCard) return;
    const { rank } = parseCard(current.currentCard);
    if (rank !== "A") return;

    // only drawer can start
    if (current.waterfall.drawer !== me.current) return;

    if (!isHostMe()) {
      // drawer might not be host in future versions; for now host controls state
      // request host to start
      await send({ type: "WF_START_REQ", requestedBy: me.current });
      return;
    }

    if (current.waterfall.phase !== "ready") return;

    const next = clone(current);
    const startAt = Date.now();
    const endAt = startAt + next.waterfall.durationSec * 1000;

    next.waterfall.phase = "running";
    next.waterfall.startAtMs = startAt;
    next.waterfall.endAtMs = endAt;

    // still locked during running
    next.deckLocked = true;
    next.turn = next.waterfall.drawer; // stay on drawer

    await broadcastState(next);
  }

  // ✅ host checks for waterfall end and unlocks + advances turn
  useEffect(() => {
    if (!connected) return;
    if (!isHostMe()) return;

    const current = stateRef.current;
    if (current.waterfall.phase !== "running") return;
    if (!current.waterfall.endAtMs) return;

    if (Date.now() >= current.waterfall.endAtMs) {
      const next = clone(current);

      const drawer = next.waterfall.drawer;
      next.waterfall = {
        phase: "idle",
        drawer: null,
        durationSec: 0,
        startAtMs: null,
        endAtMs: null,
      };

      // unlock deck
      next.deckLocked = false;

      // ✅ now the turn advances AFTER waterfall completes
      next.turn = advanceTurnFrom(next, drawer);

      // broadcast
      broadcastState(next).catch(() => {});
    }
  }, [nowMs, connected]);

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

          // if turn holder left, advance
          if (n.turn === participant.identity) n.turn = advanceTurnFrom(n, participant.identity);

          // if a holder leaves, clear holder
          if (n.heavenHolder === participant.identity) n.heavenHolder = null;
          if (n.thumbHolder === participant.identity) n.thumbHolder = null;
          if (n.qmHolder === participant.identity) n.qmHolder = null;
          if (n.kingHolder === participant.identity) n.kingHolder = null;

          // if waterfall drawer left, cancel waterfall + unlock
          if (n.waterfall.drawer === participant.identity) {
            n.waterfall = { phase: "idle", drawer: null, durationSec: 0, startAtMs: null, endAtMs: null };
            n.deckLocked = false;
          }

          return n;
        });
      });

      room.on(RoomEvent.DataReceived, (buf) => {
        const msg = decode(buf);
        if (!msg) return;

        if (msg.type === "STATE") {
          const incomingRaw = msg.data ?? {};
          const incoming: GameState = {
            ...makeDefaultState(),
            ...incomingRaw,
            waterfall: {
              ...makeDefaultState().waterfall,
              ...(incomingRaw.waterfall ?? {}),
            },
          };
          setState(incoming);
          return;
        }

        if (msg.type === "DRAW") {
          const current = stateRef.current;
          if (roomRef.current && me.current && current.host === me.current) {
            draw();
          }
          return;
        }

        if (msg.type === "WF_START_REQ") {
          const current = stateRef.current;
          if (roomRef.current && me.current && current.host === me.current) {
            // host only
            // only accept if requester is current drawer and we are in ready phase
            if (
              current.waterfall.phase === "ready" &&
              current.waterfall.drawer &&
              msg.requestedBy === current.waterfall.drawer
            ) {
              startWaterfall();
            }
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

      // enable camera/mic
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

    setState(makeDefaultState());
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

  const wf = state.waterfall;
  const wfActive = wf.phase !== "idle";
  const wfIsAce = parseCard(state.currentCard).rank === "A";
  const wfRemainingSec = useMemo(() => {
    if (wf.phase !== "running" || !wf.endAtMs) return null;
    const remain = Math.ceil((wf.endAtMs - nowMs) / 1000);
    return Math.max(0, remain);
  }, [wf.phase, wf.endAtMs, nowMs]);

  const deckIsLocked = isDeckLocked(state);

  const canStartWaterfall =
    wfIsAce && wf.phase === "ready" && wf.drawer === me.current && (isHostMe() || true);

  const drawerName = wf.drawer || "—";

  return (
    <div className="appB">
      {/* Safety CSS + turn highlight */}
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
          box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.35), 0 0 0 6px rgba(34, 197, 94, 0.12);
          border-color: rgba(34, 197, 94, 0.35) !important;
        }
        .deckLockedPillB {
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 1000;
          background: rgba(2, 6, 23, 0.35);
          border: 1px solid rgba(148, 163, 184, 0.16);
          opacity: 0.95;
          white-space: nowrap;
        }
        .wfBtnB {
          width: 100%;
          border: 0;
          border-radius: 18px;
          padding: 14px 12px;
          font-weight: 1100;
          font-size: 16px;
          letter-spacing: 0.06em;
          color: rgba(226, 232, 240, 0.95);
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.24), rgba(2, 6, 23, 0.35));
          border: 1px solid rgba(34, 197, 94, 0.22);
          cursor: pointer;
        }
        .wfBtnB:disabled {
          opacity: 0.6;
          cursor: default;
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
                const isTurn = id === state.turn;

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
              <button className="drawComboB" onClick={draw} disabled={deckIsLocked}>
                <div className="cardSquareB">
                  <CardFace card={state.currentCard} />
                </div>

                <div className="drawTextB">
                  <div className="drawTitleB">TURN</div>
                  <div className="turnLineB">{turnLabel}</div>
                  <div className="ruleLineB">{ruleText}</div>

                  {wfActive ? (
                    <div className="tapLineB">Deck locked</div>
                  ) : (
                    <div className="tapLineB">{state.host === me.current ? "Tap to draw" : "Tap to request draw"}</div>
                  )}
                </div>

                <div className="drawMetaB">
                  <div className="metaPillB">🃏 {state.deck.length}</div>
                  <div className="metaPillB">{state.host === me.current ? "HOST" : "GUEST"}</div>
                </div>
              </button>

              {/* ✅ Waterfall controls live inside the deck card area */}
              {wfIsAce && wf.phase !== "idle" ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div className="deckLockedPillB">
                    {wf.phase === "ready" ? (
                      <>
                        WATERFALL READY · {wf.durationSec}s (random) · Drawer: <b>{drawerName}</b>
                      </>
                    ) : (
                      <>
                        WATERFALL RUNNING · Remaining: <b>{wfRemainingSec ?? "—"}s</b> · Clockwise
                      </>
                    )}
                  </div>

                  <div className="deckLockedPillB" style={{ opacity: 0.85 }}>
                    Deck locked
                  </div>

                  <button className="wfBtnB" onClick={startWaterfall} disabled={!canStartWaterfall || wf.phase !== "ready"}>
                    {wf.drawer === me.current ? "READY / START WATERFALL" : "WAITING FOR DRAWER"}
                  </button>
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
                  const isTurn = id === state.turn;

                  return (
                    <div key={p.name} className="pRowB" style={isTurn ? { outline: "2px solid rgba(34,197,94,0.22)", outlineOffset: "-2px" } : undefined}>
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
