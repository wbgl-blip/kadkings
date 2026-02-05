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
  // more reliable than structuredClone across mobile browsers
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

function computeVideoLayout(count: number): "l1" | "l2" | "l3" | "l4" | "l5" | "l6" {
  // B: auto-scale for 1–6 players, max 3x2
  if (count <= 1) return "l1"; // 1x1
  if (count === 2) return "l2"; // 2x1
  if (count === 3) return "l3"; // 3x1
  if (count === 4) return "l4"; // 2x2
  if (count === 5) return "l5"; // 3x2 with 2 in last row
  return "l6"; // 3x2
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
    players: {}
  });

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState("");

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [state, setState] = useState<GameState>({
    host: null,
    deck: [],
    currentCard: null,
    players: {}
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  async function attachLocalTracks(room: Room) {
    // local tracks exist only after enabling cam/mic
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
      gs.players[id] = {
        name: id,
        drinks: 0,
        cardsDrawn: 0
      };
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

    if (!next.deck.length) {
      next.deck = shuffle(buildDeck());
    }

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
      patch: { drinks: next.players[me.current].drinks }
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
      // 1) get token + url
      const res = await fetch(`/api/token?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(identity)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || `Token API failed (${res.status})`);
      }
      if (!data?.token || !data?.url) {
        throw new Error("Token API returned missing token/url.");
      }

      // 2) connect
      const room = new Room();
      roomRef.current = room;
      me.current = identity;

      // ensure "me" tile early (will show once camera enabled)
      ensureTile(identity);

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        // ensure player exists for layout + stats list
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

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeTile(participant.identity);
        setState((s) => {
          const n = clone(s);
          if (n.players[participant.identity]) delete n.players[participant.identity];
          // if host left, keep host as-is for now; you can add host reassignment later
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
          // only host should execute draws (use ref to avoid stale state)
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

      // 3) mark connected so UI advances immediately
      setConnected(true);

      // 4) initialize state (host if first)
      const current = stateRef.current;
      const next = clone(current);
      ensurePlayer(next, identity);

      if (!next.host) {
        next.host = identity;
        next.deck = shuffle(buildDeck());
      }

      setState(next);
      await send({ type: "STATE", data: next });

      // 5) ask for camera/mic AFTER UI is advanced
      try {
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        await attachLocalTracks(room);
      } catch (e: any) {
        setErrMsg(`Connected, but camera/mic blocked: ${e?.message || e}`);
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

    // clean up tiles so the next join is fresh
    if (videoRef.current) videoRef.current.innerHTML = "";

    setConnected(false);
  }

  /* =========================
     UI (B layout)
  ========================= */

  const players = useMemo(() => Object.values(state.players), [state.players]);

  // For layout sizing we want the "active tile" count. Prefer actual tiles if present.
  const tileCount =
    (videoRef.current?.querySelectorAll?.(".vTile")?.length || 0) > 0
      ? (videoRef.current?.querySelectorAll?.(".vTile")?.length as number)
      : Math.max(1, players.length || 1);

  const layout = computeVideoLayout(Math.min(6, Math.max(1, tileCount)));

  return (
    <div className="appB">
      <style jsx global>{`
        /* =========================
           ONE-SCREEN B LAYOUT
           - Players/video always visible, main focus
           - Deck + stats compact, always visible
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

        .logoB {
          width: 42px;
          height: 42px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          font-weight: 900;
          letter-spacing: 0.06em;
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.22), rgba(34, 197, 94, 0.1));
          border: 1px solid rgba(34, 197, 94, 0.22);
          color: rgba(226, 232, 240, 0.95);
          flex: 0 0 auto;
        }

        .titleB {
          font-size: 18px;
          font-weight: 900;
          line-height: 1.1;
        }

        .subB {
          font-size: 12px;
          opacity: 0.8;
          line-height: 1.2;
        }

        .statusB {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-weight: 800;
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

        .shellB {
          display: grid;
          grid-template-rows: 1fr auto;
          gap: 10px;
          overflow: hidden;
        }

        .cardB {
          background: rgba(15, 23, 42, 0.45);
          border: 1px solid rgba(148, 163, 184, 0.16);
          border-radius: 18px;
          padding: 12px;
          overflow: hidden;
        }

        .joinCardB {
          display: grid;
          gap: 10px;
        }

        .fieldB {
          display: grid;
          gap: 6px;
          font-weight: 800;
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
        }

        .btnB:disabled {
          opacity: 0.55;
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
           VIDEO AREA (main focus)
        ========================= */

        .videoCardB {
          display: grid;
          grid-template-rows: auto 1fr auto;
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

        /* Layout variants driven by data-layout */
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
          font-weight: 900;
          background: rgba(2, 6, 23, 0.55);
          border: 1px solid rgba(148, 163, 184, 0.18);
          color: rgba(226, 232, 240, 0.95);
          max-width: calc(100% - 20px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* =========================
           BOTTOM BAR (compact)
        ========================= */

        .bottomBarB {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          min-height: 0;
        }

        .deckMiniB {
          display: grid;
          grid-template-rows: auto auto;
          gap: 8px;
          min-height: 0;
        }

        .pillB {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 900;
          background: rgba(2, 6, 23, 0.35);
          border: 1px solid rgba(148, 163, 184, 0.16);
          opacity: 0.95;
        }

        .deckBtnB {
          width: 100%;
          border: 0;
          border-radius: 16px;
          padding: 14px 12px;
          font-weight: 1000;
          letter-spacing: 0.06em;
          color: rgba(226, 232, 240, 0.95);
          background: linear-gradient(180deg, rgba(34, 197, 94, 0.24), rgba(34, 197, 94, 0.12));
          border: 1px solid rgba(34, 197, 94, 0.22);
        }

        .deckBtnB:active {
          transform: translateY(1px);
        }

        .cardNowB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.16);
          background: rgba(2, 6, 23, 0.30);
          font-weight: 900;
        }

        .labelMiniB {
          font-size: 12px;
          opacity: 0.8;
          font-weight: 900;
        }

        .cardTextB {
          font-size: 16px;
          font-weight: 1000;
        }

        .statsMiniB {
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 8px;
          min-height: 0;
        }

        .yourDrinksRowB {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.16);
          background: rgba(2, 6, 23, 0.30);
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
          padding-right: 4px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.16);
          background: rgba(2, 6, 23, 0.22);
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

      <div className="topbarB">
        <div className="brandB">
          <div className="logoB">KAD</div>
          <div style={{ minWidth: 0 }}>
            <div className="titleB">KAD Kings</div>
            <div className="subB">Players always visible · one-screen</div>
          </div>
        </div>

        <div className="statusB">
          <span
            className="dotB"
            style={{
              background: connected ? "rgba(34,197,94,0.9)" : "rgba(148,163,184,0.9)"
            }}
          />
          {connected ? "Connected" : "Not connected"}
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
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ty" />
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
          {/* TOP / MAIN: VIDEO (always dominant) */}
          <div className="cardB videoCardB">
            <div className="cardHeadB">
              <h2>Players</h2>
              <div className="rowB" style={{ justifyContent: "flex-end" }}>
                <span className="pillB">Host: {state.host || "—"}</span>
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

            <div className="noteB">
              If you can’t see yourself: check browser permissions (camera/mic allowed).
            </div>
          </div>

          {/* BOTTOM: DECK + STATS (compact, always visible) */}
          <div className="bottomBarB">
            <div className="cardB deckMiniB">
              <div className="rowB" style={{ justifyContent: "space-between" }}>
                <div className="labelMiniB">Deck</div>
                <span className="pillB">{state.host === me.current ? "You are host" : "Tap to request draw"}</span>
              </div>

              <button className="deckBtnB" onClick={draw}>
                DRAW
              </button>

              <div className="cardNowB">
                <div className="labelMiniB">Card</div>
                <div className="cardTextB">{state.currentCard || "—"}</div>
              </div>
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
                {players.map((p) => (
                  <div key={p.name} className="pRowB">
                    <div className="pNameB">{p.name}</div>
                    <div className="pMetaB">
                      🍺 {p.drinks} · 🃏 {p.cardsDrawn}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
