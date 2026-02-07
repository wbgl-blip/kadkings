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

type PowerKind = "heaven" | "thumb";

type PowerRound = {
  kind: PowerKind;
  active: boolean;
  startedBy: string; // holder who started it
  eligible: string[]; // snapshot of players at start
  tapped: string[]; // order of taps; last = loser
  loser: string | null; // set when complete
  startedAt: number; // Date.now()
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
  qmHolder: string | null; // Q (badge only for now)
  kingHolder: string | null; // K (badge only for now)

  // Active power round (7/J fires)
  powerRound: PowerRound | null;
};

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW"; requestedBy?: string }
  | { type: "UPDATE"; id: string; patch: Partial<PlayerStats> }
  | { type: "POWER_START"; kind: PowerKind; requestedBy: string }
  | { type: "POWER_TAP"; kind: PowerKind; by: string }
  | { type: "POWER_CLEAR"; requestedBy: string };

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
      return "Ace = Waterfall (ready/start flow).";
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
      return "7 = Heaven power (holder can start anytime).";
    case "8":
      return "8 = Mate (one-way chain).";
    case "9":
      return "9 = Rhyme.";
    case "10":
      return "10 = Categories.";
    case "J":
      return "Jack = Thumbmaster power (holder can start anytime).";
    case "Q":
      return "Queen = Question Master (badge for now).";
    case "K":
      return "King = Make a rule (badge for now).";
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
  };

  const stateRef = useRef<GameState>(clone(emptyState));

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState(""); // starts blank

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [isFs, setIsFs] = useState(false);

  const [state, setState] = useState<GameState>(clone(emptyState));

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

  function kindToLabel(kind: PowerKind) {
    return kind === "heaven" ? "HEAVEN" : "THUMB";
  }

  function canStartPower(gs: GameState, kind: PowerKind, who: string): boolean {
    const holder = holderFor(gs, kind);
    if (!holder || holder !== who) return false;

    // If another power is active, don't allow starting a new one.
    if (gs.powerRound?.active) return false;

    return true;
  }

  function startPowerRoundHost(gs: GameState, kind: PowerKind, startedBy: string): GameState {
    const next = clone(gs);
    const holder = holderFor(next, kind);
    if (!holder || holder !== startedBy) return next;
    if (next.powerRound?.active) return next;

    // Eligible = current connected players snapshot (max 6)
    const eligible = getTurnOrder(next);
    // Ensure holder exists as eligible if they are present
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

    // Only eligible players count
    if (!pr.eligible.includes(by)) return next;

    // One tap per player
    if (pr.tapped.includes(by)) return next;

    pr.tapped.push(by);

    // When everyone tapped, last one is loser
    if (pr.tapped.length >= pr.eligible.length) {
      pr.active = false;
      pr.loser = pr.tapped[pr.tapped.length - 1] || null;
    }

    next.powerRound = pr;
    return next;
  }

  function clearPowerHost(gs: GameState): GameState {
    const next = clone(gs);
    next.powerRound = null;
    return next;
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

    // Set power holders based on draw (holder persists until replaced by next same card draw)
    const { rank } = parseCard(card);
    if (rank === "7") next.heavenHolder = me.current;
    if (rank === "J") next.thumbHolder = me.current;
    if (rank === "Q") next.qmHolder = me.current;
    if (rank === "K") next.kingHolder = me.current;

    // If holder changed and there was an old unresolved powerRound, keep it (user can clear),
    // but do not auto-start anything.
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

  async function startPower(kind: PowerKind) {
    const current = stateRef.current;

    // Holder requests; host executes authoritative update
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

    // Guests request; host executes authoritative update
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

    // Anyone can request clear; host decides (we'll allow host or holder to clear)
    if (current.host !== me.current) {
      await send({ type: "POWER_CLEAR", requestedBy: me.current });
      return;
    }

    const next = clearPowerHost(current);
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

          // if a holder leaves, clear that holder
          if (n.heavenHolder === participant.identity) n.heavenHolder = null;
          if (n.thumbHolder === participant.identity) n.thumbHolder = null;
          if (n.qmHolder === participant.identity) n.qmHolder = null;
          if (n.kingHolder === participant.identity) n.kingHolder = null;

          // if power round active and someone left:
          // - remove from eligible
          // - if that completes the round, finalize loser
          if (n.powerRound?.active) {
            const pr = n.powerRound;
            pr.eligible = pr.eligible.filter((id) => id !== participant.identity);
            pr.tapped = pr.tapped.filter((id) => id !== participant.identity);

            if (pr.eligible.length > 0 && pr.tapped.length >= pr.eligible.length) {
              pr.active = false;
              pr.loser = pr.tapped[pr.tapped.length - 1] || null;
            }
            n.powerRound = pr;
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
          };
          setState(incoming);
          return;
        }

        // Host: execute draw on request
        if (msg.type === "DRAW") {
          const current = stateRef.current;
          if (roomRef.current && me.current && current.host === me.current) {
            draw();
          }
          return;
        }

        // Host: start power on request
        if (msg.type === "POWER_START") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const requestedBy = msg.requestedBy as string;
            const kind = msg.kind as PowerKind;
            const next = startPowerRoundHost(current, kind, requestedBy);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        // Host: tap power on request
        if (msg.type === "POWER_TAP") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const by = msg.by as string;
            const kind = msg.kind as PowerKind;
            const next = tapPowerHost(current, kind, by);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        // Host: clear power (allow host OR holder who requested)
        if (msg.type === "POWER_CLEAR") {
          const current = stateRef.current;
          if (current.host === me.current) {
            const requestedBy = msg.requestedBy as string;

            const pr = current.powerRound;
            const holder =
              pr?.kind === "heaven" ? current.heavenHolder : pr?.kind === "thumb" ? current.thumbHolder : null;

            if (!pr) return;

            const allowed = requestedBy === current.host || (holder && requestedBy === holder);
            if (!allowed) return;

            const next = clearPowerHost(current);
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }

        // Player stat updates
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

    setState(clone(emptyState));
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

  const activePR = state.powerRound?.active ? state.powerRound : null;
  const prKind = state.powerRound?.kind ?? null;

  const iAmHeavenHolder = state.heavenHolder === me.current;
  const iAmThumbHolder = state.thumbHolder === me.current;

  const canStartHeaven = canStartPower(state, "heaven", me.current);
  const canStartThumb = canStartPower(state, "thumb", me.current);

  const iCanTap =
    activePR && me.current && activePR.eligible.includes(me.current) && !activePR.tapped.includes(me.current);

  const showPowerPanel = true; // always show holder controls area (small)

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
      {/* Small safety styles + new UI bits (turn highlight + power buttons) */}
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
        .powerBarB {
          margin-top: 10px;
          display: grid;
          gap: 8px;
        }
        .powerRowB {
          display: flex;
          gap: 8px;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border-radius: 16px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(2, 6, 23, 0.18);
        }
        .powerLeftB {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .powerTitleB {
          font-weight: 1000;
          font-size: 12px;
          letter-spacing: 0.06em;
          opacity: 0.92;
        }
        .powerSubB {
          font-size: 12px;
          font-weight: 900;
          opacity: 0.78;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .powerBtnB {
          border: 0;
          border-radius: 16px;
          padding: 10px 12px;
          font-weight: 1000;
          letter-spacing: 0.06em;
          color: rgba(226, 232, 240, 0.95);
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.24), rgba(2, 6, 23, 0.35));
          border: 1px solid rgba(34, 197, 94, 0.22);
          cursor: pointer;
          white-space: nowrap;
        }
        .powerBtnB:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .powerTapB {
          background: linear-gradient(180deg, rgba(248, 113, 113, 0.22), rgba(2, 6, 23, 0.35));
          border: 1px solid rgba(248, 113, 113, 0.22);
        }
        .powerClearB {
          background: rgba(148, 163, 184, 0.16);
          border: 1px solid rgba(148, 163, 184, 0.16);
        }
      `}</style>

      {/* TOP BAR */}
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

              {/* POWER PANEL (Heaven / Thumb) */}
              {showPowerPanel ? (
                <div className="powerBarB">
                  <div className="powerRowB">
                    <div className="powerLeftB">
                      <div className="powerTitleB">☁️ HEAVEN POWER</div>
                      <div className="powerSubB">
                        Holder: <b>{state.heavenHolder || "—"}</b>
                        {activePR?.kind === "heaven" ? (
                          <>
                            {" "}
                            · <b>ACTIVE</b> ({activePR.tapped.length}/{activePR.eligible.length})
                          </>
                        ) : state.powerRound?.kind === "heaven" && state.powerRound?.loser ? (
                          <>
                            {" "}
                            · Loser: <b>{state.powerRound.loser}</b>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {activePR?.kind === "heaven" ? (
                      <>
                        <button className="powerBtnB powerTapB" onClick={() => tapPower("heaven")} disabled={!iCanTap}>
                          TAP
                        </button>
                      </>
                    ) : (
                      <button className="powerBtnB" onClick={() => startPower("heaven")} disabled={!canStartHeaven}>
                        {iAmHeavenHolder ? "START" : "START"}
                      </button>
                    )}
                  </div>

                  <div className="powerRowB">
                    <div className="powerLeftB">
                      <div className="powerTitleB">👍 THUMB POWER</div>
                      <div className="powerSubB">
                        Holder: <b>{state.thumbHolder || "—"}</b>
                        {activePR?.kind === "thumb" ? (
                          <>
                            {" "}
                            · <b>ACTIVE</b> ({activePR.tapped.length}/{activePR.eligible.length})
                          </>
                        ) : state.powerRound?.kind === "thumb" && state.powerRound?.loser ? (
                          <>
                            {" "}
                            · Loser: <b>{state.powerRound.loser}</b>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {activePR?.kind === "thumb" ? (
                      <button className="powerBtnB powerTapB" onClick={() => tapPower("thumb")} disabled={!iCanTap}>
                        TAP
                      </button>
                    ) : (
                      <button className="powerBtnB" onClick={() => startPower("thumb")} disabled={!canStartThumb}>
                        {iAmThumbHolder ? "START" : "START"}
                      </button>
                    )}
                  </div>

                  {/* Clear button when there is a finished/active power round */}
                  {state.powerRound ? (
                    <div className="powerRowB">
                      <div className="powerLeftB">
                        <div className="powerTitleB">POWER ROUND</div>
                        <div className="powerSubB">
                          {state.powerRound.active ? (
                            <>
                              Active: <b>{kindToLabel(state.powerRound.kind)}</b> · Started by{" "}
                              <b>{state.powerRound.startedBy}</b>
                            </>
                          ) : (
                            <>
                              Last: <b>{kindToLabel(state.powerRound.kind)}</b> · Loser:{" "}
                              <b>{state.powerRound.loser || "—"}</b>
                            </>
                          )}
                        </div>
                      </div>

                      <button className="powerBtnB powerClearB" onClick={clearPower}>
                        CLEAR
                      </button>
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

      {/* Attach local tracks whenever we connect + tiles exist */}
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
