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

type GameState = {
  host: string | null;
  deck: string[];
  currentCard: string | null;

  // NEW: turn tracking + last drawer
  turn: string | null;
  lastDrawBy: string | null;

  players: Record<string, PlayerStats>;
};

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW"; requestedBy?: string }
  | { type: "UPDATE"; id: string; patch: Partial<PlayerStats> };

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

  // Keep this simple for now (we can expand to the full “power card” flows next).
  switch (rank) {
    case "A":
      return "Ace = Waterfall (optional timer/ready-check later).";
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
      return "7 = Heaven (power button; last to tap/raise loses).";
    case "8":
      return "8 = Mate (one-way chain).";
    case "9":
      return "9 = Rhyme (vote if needed).";
    case "10":
      return "10 = Categories (go around).";
    case "J":
      return "Jack = Thumbmaster (power button; last loses).";
    case "Q":
      return "Queen = Question Master (gotcha).";
    case "K":
      return "King = Make a rule (stays active).";
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

  const stateRef = useRef<GameState>({
    host: null,
    deck: [],
    currentCard: null,
    turn: null,
    lastDrawBy: null,
    players: {},
  });

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState(""); // starts blank (fixed)

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [isFs, setIsFs] = useState(false);

  const [state, setState] = useState<GameState>({
    host: null,
    deck: [],
    currentCard: null,
    turn: null,
    lastDrawBy: null,
    players: {},
  });

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
    // keep host first if present, then alpha
    const host = gs.host ? [gs.host] : [];
    const rest = ids.filter((x) => x !== gs.host).sort((a, b) => a.localeCompare(b));
    const merged = [...host, ...rest];
    // de-dupe just in case
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

  async function draw() {
    const r = roomRef.current;
    if (!r) return;

    const current = stateRef.current;

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

    // turn advances AFTER a successful draw (simple rotate)
    next.turn = advanceTurn(next);

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

  /* =========================
     VIDEO ATTACHMENT (React tiles)
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
          // keep turn sane if missing
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
          if (n.turn === participant.identity) n.turn = advanceTurn(n);

          return n;
        });
      });

      room.on(RoomEvent.DataReceived, (buf) => {
        const msg = decode(buf);
        if (!msg) return;

        if (msg.type === "STATE") {
          // backward-safe defaults
          const incoming: GameState = {
            host: msg.data.host ?? null,
            deck: msg.data.deck ?? [],
            currentCard: msg.data.currentCard ?? null,
            turn: msg.data.turn ?? msg.data.host ?? null,
            lastDrawBy: msg.data.lastDrawBy ?? null,
            players: msg.data.players ?? {},
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
        // ensure turn exists
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

    setState({
      host: null,
      deck: [],
      currentCard: null,
      turn: null,
      lastDrawBy: null,
      players: {},
    });

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
    const merged = [...mine, ...others].slice(0, 6);
    return merged;
  }, [state.players]);

  const slotIds = useMemo(() => {
    const filled = [...orderedPlayers];
    while (filled.length < 6) filled.push(`__EMPTY__${filled.length + 1}`);
    return filled.slice(0, 6);
  }, [orderedPlayers]);

  const effectiveCount = Math.min(6, Math.max(1, orderedPlayers.length || 1));
  const layout = computeVideoLayout(effectiveCount);

  const { rank, suit } = parseCard(state.currentCard);
  const ruleText = useMemo(() => ruleForCard(state.currentCard), [state.currentCard]);

  const turnLabel = state.turn || state.host || "—";

  function CardFace({ card }: { card: string | null }) {
    const { rank: rnk, suit: sut } = parseCard(card);
    const red = isRedSuit(sut);

    return (
      <div className="bigCardB" aria-label="current card">
        <div className="cornerTL">
          <div className="cornerRank" style={{ color: red ? "rgba(239,68,68,0.95)" : "rgba(2,6,23,0.9)" }}>
            {rnk}
          </div>
          <div className="cornerSuit" style={{ color: red ? "rgba(239,68,68,0.95)" : "rgba(2,6,23,0.9)" }}>
            {sut || " "}
          </div>
        </div>

        <div
          className="centerSuit"
          style={{ color: red ? "rgba(239,68,68,0.20)" : "rgba(2,6,23,0.12)" }}
        >
          {sut || " "}
        </div>

        <div className="cornerBR">
          <div className="cornerRank" style={{ color: red ? "rgba(239,68,68,0.95)" : "rgba(2,6,23,0.9)" }}>
            {rnk}
          </div>
          <div className="cornerSuit" style={{ color: red ? "rgba(239,68,68,0.95)" : "rgba(2,6,23,0.9)" }}>
            {sut || " "}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="appB">
      <style jsx global>{`
        /* =========================
           ONE-SCREEN B LAYOUT
        ========================= */

        .appB {
          height: 100svh;
          width: min(520px, 100%);
          margin: 0 auto;
          padding: 12px;
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 10px;
          overflow: hidden;
        }

        .topbarB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .brandB {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        /* NEW: real logo image */
        .logoImgB {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          object-fit: cover;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(2, 6, 23, 0.35);
          flex: 0 0 auto;
        }

        .titleB {
          font-size: 18px;
          font-weight: 900;
          line-height: 1.1;
          letter-spacing: 0.02em;
        }

        .statusB {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-weight: 900;
          font-size: 12px;
          white-space: nowrap;
          padding: 8px 10px;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.55);
          border: 1px solid rgba(148, 163, 184, 0.18);
        }

        .dotB {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          box-shadow: 0 0 0 4px rgba(148, 163, 184, 0.12);
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
        }

        .shellB {
          display: grid;
          grid-template-rows: 1fr auto;
          gap: 10px;
          overflow: hidden;
          min-height: 0;
        }

        .cardB {
          background: rgba(15, 23, 42, 0.45);
          border: 1px solid rgba(148, 163, 184, 0.16);
          border-radius: 18px;
          padding: 12px;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }

        .joinCardB {
          display: grid;
          gap: 10px;
        }

        .fieldB {
          display: grid;
          gap: 6px;
          font-weight: 900;
          font-size: 12px;
          opacity: 0.95;
        }

        .fieldB input {
          width: 100%;
          padding: 12px 12px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.16);
          background: rgba(2, 6, 23, 0.35);
          color: rgba(226, 232, 240, 0.95);
          outline: none;
        }

        .fieldB input:focus {
          border-color: rgba(34, 197, 94, 0.35);
          box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12);
        }

        .rowB {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .btnB {
          border: 0;
          border-radius: 14px;
          padding: 12px 14px;
          font-weight: 900;
          color: rgba(226, 232, 240, 0.95);
          background: rgba(148, 163, 184, 0.16);
          border: 1px solid rgba(148, 163, 184, 0.16);
          cursor: pointer;
        }

        .btnB:disabled {
          opacity: 0.55;
          cursor: default;
        }

        .btnPrimaryB {
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.35), rgba(34, 197, 94, 0.18));
          border-color: rgba(34, 197, 94, 0.28);
        }

        .btnDangerB {
          background: linear-gradient(180deg, rgba(248, 113, 113, 0.30), rgba(248, 113, 113, 0.14));
          border-color: rgba(248, 113, 113, 0.25);
        }

        .btnTinyB {
          padding: 10px 12px;
          border-radius: 12px;
          font-size: 12px;
        }

        .noteB {
          font-size: 12px;
          opacity: 0.85;
          line-height: 1.25;
        }

        /* =========================
           VIDEO AREA
        ========================= */

        .videoCardB {
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 10px;
          min-height: 0;
        }

        .cardHeadB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .cardHeadB h2 {
          margin: 0;
          font-size: 14px;
          font-weight: 900;
          letter-spacing: 0.02em;
        }

        .videoGridB {
          min-height: 0;
          display: grid;
          gap: 8px;
          align-content: stretch;
          justify-content: stretch;
        }

        .videoGridB[data-layout="l1"] {
          grid-template-columns: 1fr;
          grid-template-rows: 1fr;
        }
        .videoGridB[data-layout="l2"] {
          grid-template-columns: repeat(2, 1fr);
          grid-template-rows: 1fr;
        }
        .videoGridB[data-layout="l3"] {
          grid-template-columns: repeat(3, 1fr);
          grid-template-rows: 1fr;
        }
        .videoGridB[data-layout="l4"] {
          grid-template-columns: repeat(2, 1fr);
          grid-template-rows: repeat(2, 1fr);
        }
        .videoGridB[data-layout="l5"],
        .videoGridB[data-layout="l6"] {
          grid-template-columns: repeat(3, 1fr);
          grid-template-rows: repeat(2, 1fr);
        }

        .vTile {
          position: relative;
          border-radius: 16px;
          overflow: hidden;
          background: rgba(2, 6, 23, 0.35);
          border: 1px solid rgba(148, 163, 184, 0.16);
          min-height: 0;
        }

        .vTile video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          background: rgba(2, 6, 23, 0.35);
        }

        .vTag {
          position: absolute;
          left: 10px;
          bottom: 10px;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 900;
          background: rgba(2, 6, 23, 0.55);
          border: 1px solid rgba(148, 163, 184, 0.18);
          color: rgba(226, 232, 240, 0.95);
          max-width: calc(100% - 20px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Empty placeholders */
        .vEmpty {
          display: grid;
          place-items: center;
          color: rgba(226, 232, 240, 0.35);
          font-weight: 1000;
          letter-spacing: 0.04em;
        }

        .vPlus {
          font-size: 42px;
          line-height: 1;
          opacity: 0.35;
        }

        .vEmptyTag {
          position: absolute;
          left: 10px;
          bottom: 10px;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 900;
          background: rgba(2, 6, 23, 0.38);
          border: 1px solid rgba(148, 163, 184, 0.14);
          color: rgba(226, 232, 240, 0.65);
        }

        /* =========================
           BOTTOM BAR (card bigger, same overall area)
        ========================= */

        .bottomBarB {
          display: grid;
          grid-template-columns: 1.15fr 0.85fr;
          gap: 10px;
          min-height: 0;
          align-items: end;
        }

        .deckMiniB {
          display: grid;
          grid-template-rows: auto;
          gap: 10px;
          min-height: 0;
        }

        .drawComboB {
          width: 100%;
          border: 0;
          border-radius: 18px;
          padding: 12px;
          display: grid;
          grid-template-columns: 108px 1fr auto; /* bigger card column */
          gap: 12px;
          align-items: center;
          color: rgba(226, 232, 240, 0.95);
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.18), rgba(2, 6, 23, 0.35));
          border: 1px solid rgba(34, 197, 94, 0.22);
          cursor: pointer;
        }

        .drawComboB:active {
          transform: translateY(1px);
        }

        /* BIGGER CARD (like your pic 3) */
        .cardSquareB {
          width: 104px;
          height: 86px;
          border-radius: 18px;
          background: rgba(2, 6, 23, 0.32);
          border: 1px solid rgba(148, 163, 184, 0.18);
          display: grid;
          place-items: center;
          overflow: hidden;
        }

        .bigCardB {
          width: 92px;
          height: 74px;
          border-radius: 16px;
          background: rgba(248, 250, 252, 0.94);
          border: 1px solid rgba(2, 6, 23, 0.25);
          position: relative;
          overflow: hidden;
        }

        .cornerTL {
          position: absolute;
          left: 10px;
          top: 8px;
          display: grid;
          gap: 2px;
        }

        .cornerBR {
          position: absolute;
          right: 10px;
          bottom: 8px;
          display: grid;
          gap: 2px;
          transform: rotate(180deg);
          transform-origin: center;
        }

        .cornerRank {
          font-weight: 1000;
          font-size: 16px;
          line-height: 1;
        }

        .cornerSuit {
          font-weight: 1000;
          font-size: 14px;
          line-height: 1;
        }

        .centerSuit {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -48%);
          font-size: 44px;
          font-weight: 900;
          line-height: 1;
          user-select: none;
        }

        .drawTextB {
          min-width: 0;
          text-align: left;
        }

        /* Replace “CURRENT CARD / tap to draw” with turn + rule */
        .drawTitleB {
          font-weight: 1000;
          letter-spacing: 0.06em;
          font-size: 13px;
          line-height: 1.05;
          opacity: 0.9;
        }

        .turnLineB {
          margin-top: 6px;
          font-weight: 1000;
          font-size: 16px;
          letter-spacing: 0.02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .ruleLineB {
          margin-top: 4px;
          font-size: 12px;
          opacity: 0.85;
          font-weight: 900;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .tapLineB {
          margin-top: 6px;
          font-size: 12px;
          opacity: 0.75;
          font-weight: 900;
        }

        .drawMetaB {
          display: grid;
          justify-items: end;
          gap: 6px;
        }

        .metaPillB {
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 900;
          background: rgba(2, 6, 23, 0.35);
          border: 1px solid rgba(148, 163, 184, 0.16);
          opacity: 0.95;
          white-space: nowrap;
        }

        .statsMiniB {
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 10px;
          min-height: 0;
        }

        .yourDrinksRowB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.16);
          background: rgba(2, 6, 23, 0.28);
        }

        .labelMiniB {
          font-size: 12px;
          opacity: 0.8;
          font-weight: 900;
        }

        .drinkNumB {
          font-weight: 1000;
          font-size: 18px;
        }

        .btnGroupB {
          display: inline-flex;
          gap: 8px;
        }

        .playersMiniListB {
          min-height: 0;
          overflow: auto;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(2, 6, 23, 0.18);
        }

        .pRowB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.10);
        }

        .pRowB:last-child {
          border-bottom: 0;
        }

        .pNameB {
          font-weight: 1000;
        }

        .pMetaB {
          opacity: 0.9;
          font-weight: 800;
          font-size: 12px;
          white-space: nowrap;
        }

        @media (max-width: 420px) {
          .bottomBarB {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {/* TOP BAR: logo + title + fullscreen + status (no extra info line) */}
      <div className="topbarB">
        <div className="brandB">
          <img className="logoImgB" src="/kylesadick-logo.png" alt="KylesADick logo" />
          <div style={{ minWidth: 0 }}>
            <div className="titleB">KAD-KINGS</div>
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
          {/* MAIN: VIDEO */}
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
                return (
                  <div key={id} className="vTile" data-id={id}>
                    <video
                      data-video-for={id}
                      autoPlay
                      playsInline
                      muted={isMe}
                      // avoid iOS forcing fullscreen
                      // @ts-ignore
                      webkit-playsinline="true"
                    />
                    <div className="vTag">{id}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* BOTTOM */}
          <div className="bottomBarB">
            <div className="cardB deckMiniB">
              <button className="drawComboB" onClick={draw}>
                <div className="cardSquareB">
                  <CardFace card={state.currentCard} />
                </div>

                <div className="drawTextB">
                  <div className="drawTitleB">TURN</div>
                  <div className="turnLineB">{turnLabel}</div>
                  <div className="ruleLineB">{ruleText}</div>
                  <div className="tapLineB">{state.host === me.current ? "Tap to draw" : "Tap to request draw"}</div>
                </div>

                <div className="drawMetaB">
                  <div className="metaPillB">🃏 {state.deck.length}</div>
                  <div className="metaPillB">{state.host === me.current ? "HOST" : "GUEST"}</div>
                </div>
              </button>
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
                  return (
                    <div key={p.name} className="pRowB">
                      <div className="pNameB">{p.name}</div>
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

      {/* Attach local tracks whenever we connect + tiles exist */}
      <AttachLocalOnConnect connected={connected} me={me} roomRef={roomRef} attachLocalTracks={attachLocalTracks} />
    </div>
  );
}

/* =========================
   Helper component: attach local video after mount
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

    // slight delay so React tiles render before attach
    const t = setTimeout(() => {
      attachLocalTracks(room, identity).catch(() => {});
    }, 150);

    return () => clearTimeout(t);
  }, [connected, me, roomRef, attachLocalTracks]);

  return null;
              }
