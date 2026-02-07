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
  players: Record<string, PlayerStats>;
};

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW" }
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

/* =========================
   MAIN APP
========================= */

export default function Page() {
  const roomRef = useRef<Room | null>(null);
  const me = useRef<string>("");
  const videoRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<GameState>({
    host: null,
    deck: [],
    currentCard: null,
    players: {},
  });

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState(""); // ✅ start blank

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [state, setState] = useState<GameState>({
    host: null,
    deck: [],
    currentCard: null,
    players: {},
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /* =========================
     FULLSCREEN
  ========================= */

  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    onFs();
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // some mobile browsers block fullscreen; ignore
    }
  }

  /* =========================
     VIDEO HANDLING
  ========================= */

  function ensureTile(id: string) {
    const root = videoRef.current;
    if (!root) return null;

    let el = root.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLDivElement | null;

    if (!el) {
      el = document.createElement("div");
      el.className = "vTile";
      el.dataset.id = id;

      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.muted = id === me.current;

      const tag = document.createElement("div");
      tag.className = "vTag";
      tag.innerText = id;

      el.append(v, tag);
      root.append(el);
    }

    return el;
  }

  function removeTile(id: string) {
    const root = videoRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
  }

  function reorderTiles(order: string[]) {
    const root = videoRef.current;
    if (!root) return;

    const map = new Map<string, HTMLElement>();
    Array.from(root.querySelectorAll(".vTile")).forEach((el) => {
      const id = (el as HTMLElement).dataset.id || "";
      if (id) map.set(id, el as HTMLElement);
    });

    for (const id of order) {
      const el = map.get(id);
      if (el) root.appendChild(el);
    }
  }

  async function attachLocalTracks(room: Room) {
    room.localParticipant.videoTrackPublications.forEach((pub) => {
      const track = pub.track;
      if (!track) return;
      const tile = ensureTile(me.current);
      if (!tile) return;
      if (track.kind === Track.Kind.Video) {
        track.attach(tile.querySelector("video")!);
      }
    });
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

  async function draw() {
    const r = roomRef.current;
    if (!r) return;

    const current = stateRef.current;

    if (current.host !== me.current) {
      await send({ type: "DRAW" });
      return;
    }

    const next = clone(current);

    if (!next.deck.length) next.deck = shuffle(buildDeck());

    const card = next.deck.shift() || null;
    next.currentCard = card;

    ensurePlayer(next, me.current);
    next.players[me.current].cardsDrawn++;

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

      ensureTile(identity);

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        setState((s) => {
          const n = clone(s);
          ensurePlayer(n, participant.identity);
          return n;
        });

        const tile = ensureTile(participant.identity);
        if (!tile) return;
        if (track.kind === Track.Kind.Video) {
          track.attach(tile.querySelector("video")!);
        }
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        setState((s) => {
          const n = clone(s);
          ensurePlayer(n, participant.identity);
          return n;
        });
        ensureTile(participant.identity);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeTile(participant.identity);
        setState((s) => {
          const n = clone(s);
          if (n.players[participant.identity]) delete n.players[participant.identity];
          return n;
        });
      });

      room.on(RoomEvent.DataReceived, (buf) => {
        const msg = decode(buf);
        if (!msg) return;

        if (msg.type === "STATE") {
          setState(msg.data);
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

      const current = stateRef.current;
      const next = clone(current);
      ensurePlayer(next, identity);

      if (!next.host) {
        next.host = identity;
        next.deck = shuffle(buildDeck());
      }

      setState(next);
      await send({ type: "STATE", data: next });

      try {
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        await attachLocalTracks(room);
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

    if (videoRef.current) videoRef.current.innerHTML = "";

    setState({
      host: null,
      deck: [],
      currentCard: null,
      players: {},
    });

    setConnected(false);
  }

  /* =========================
     UI / ORDERING / LAYOUT
  ========================= */

  const players = useMemo(() => Object.values(state.players), [state.players]);

  const orderedPlayers = useMemo(() => {
    const mine = me.current ? [me.current] : [];
    const others = Object.keys(state.players)
      .filter((id) => id && id !== me.current)
      .sort((a, b) => a.localeCompare(b));
    return [...mine, ...others].slice(0, 6);
  }, [state.players]);

  useEffect(() => {
    if (!connected) return;
    reorderTiles(orderedPlayers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, orderedPlayers.join("|")]);

  const effectiveCount = Math.min(6, Math.max(1, orderedPlayers.length || 1));
  const layout = computeVideoLayout(effectiveCount);

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

        /* =========================
           TOP BAR (MINIMAL)
        ========================= */

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

        /* ✅ logo container */
        .logoB {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid rgba(34, 197, 94, 0.22);
          background: rgba(2, 6, 23, 0.35);
          flex: 0 0 auto;
          display: grid;
          place-items: center;
        }

        /* ✅ actual logo image */
        .logoImgB {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .titleB {
          font-size: 18px;
          font-weight: 1000;
          letter-spacing: 0.06em;
          line-height: 1.05;
          white-space: nowrap;
        }

        .actionsB {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .btnIconB {
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(15, 23, 42, 0.45);
          color: rgba(226, 232, 240, 0.95);
          border-radius: 14px;
          padding: 10px 12px;
          font-weight: 900;
          cursor: pointer;
          white-space: nowrap;
        }

        .btnIconB:active {
          transform: translateY(1px);
        }

        /* =========================
           CARDS / COMMON
        ========================= */

        .cardB {
          background: rgba(15, 23, 42, 0.45);
          border: 1px solid rgba(148, 163, 184, 0.16);
          border-radius: 18px;
          padding: 12px;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }

        .shellB {
          display: grid;
          grid-template-rows: 1fr auto;
          gap: 10px;
          overflow: hidden;
          min-height: 0;
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
          font-weight: 1000;
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
        }

        .vTag {
          position: absolute;
          left: 10px;
          bottom: 10px;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 1000;
          background: rgba(2, 6, 23, 0.55);
          border: 1px solid rgba(148, 163, 184, 0.18);
          color: rgba(226, 232, 240, 0.95);
          max-width: calc(100% - 20px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* =========================
           BOTTOM BAR
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
          grid-template-columns: auto 1fr auto;
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

        .cardSquareB {
          width: 54px;
          height: 54px;
          border-radius: 16px;
          background: rgba(2, 6, 23, 0.32);
          border: 1px solid rgba(148, 163, 184, 0.18);
          display: grid;
          place-items: center;
          overflow: hidden;
        }

        .miniCardB {
          width: 42px;
          height: 42px;
          border-radius: 12px;
          background: rgba(248, 250, 252, 0.92);
          border: 1px solid rgba(2, 6, 23, 0.25);
          display: grid;
          place-items: start;
          padding: 6px;
        }

        .miniCornerB {
          color: rgba(2, 6, 23, 0.9);
          font-weight: 1000;
          font-size: 12px;
        }

        .drawTextB {
          min-width: 0;
          text-align: left;
        }

        .drawTitleB {
          font-weight: 1000;
          letter-spacing: 0.06em;
          font-size: 16px;
          line-height: 1.05;
        }

        .drawSubB {
          font-size: 12px;
          opacity: 0.8;
          margin-top: 4px;
          font-weight: 900;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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
          font-weight: 1000;
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
          font-weight: 900;
          font-size: 12px;
          white-space: nowrap;
        }

        @media (max-width: 420px) {
          .bottomBarB {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {/* ✅ MINIMAL HEADER */}
      <div className="topbarB">
        <div className="brandB">
          <div className="logoB">
            {/* ✅ replace with your actual logo image in /public */}
            <img className="logoImgB" src="/kylesadick-logo.png" alt="Kylesadick logo" />
          </div>
          <div className="titleB">KAD-KINGS</div>
        </div>

        <div className="actionsB">
          <button className="btnIconB" onClick={toggleFullscreen} type="button">
            {isFs ? "Exit" : "Fullscreen"}
          </button>
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
                <div
                  className="metaPillB"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 999,
                    background: "rgba(2,6,23,0.35)",
                    border: "1px solid rgba(148,163,184,0.16)",
                  }}
                >
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

            <div ref={videoRef} className="videoGridB" data-layout={layout} />
          </div>

          {/* BOTTOM */}
          <div className="bottomBarB">
            <div className="cardB deckMiniB">
              <button className="drawComboB" onClick={draw}>
                <div className="cardSquareB">
                  <div className="miniCardB">
                    <div className="miniCornerB">{state.currentCard || "—"}</div>
                  </div>
                </div>

                <div className="drawTextB">
                  <div className="drawTitleB">DRAW CARD</div>
                  <div className="drawSubB">{state.host === me.current ? "Tap to draw" : "Tap to request draw"}</div>
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
    </div>
  );
}
