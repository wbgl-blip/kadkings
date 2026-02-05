"use client";

import React, { useMemo, useRef, useState } from "react";
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

/* =========================
   MAIN APP
========================= */

export default function Page() {
  const roomRef = useRef<Room | null>(null);
  const me = useRef<string>("");
  const videoRef = useRef<HTMLDivElement>(null);

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

  /* =========================
     VIDEO HANDLING
  ========================= */

  function ensureTile(id: string) {
    const root = videoRef.current;
    if (!root) return null;

    let el = root.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLDivElement | null;

    if (!el) {
      el = document.createElement("div");
      el.className = "tile";
      el.dataset.id = id;

      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.muted = id === me.current;

      const tag = document.createElement("div");
      tag.className = "nameTag";
      tag.innerText = id;

      el.append(v, tag);
      root.append(el);
    }

    return el;
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

    if (state.host !== me.current) {
      await send({ type: "DRAW" });
      return;
    }

    const next = clone(state);

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
    const next = clone(state);
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

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        const tile = ensureTile(participant.identity);
        if (!tile) return;

        if (track.kind === Track.Kind.Video) {
          track.attach(tile.querySelector("video")!);
        }
      });

      room.on(RoomEvent.DataReceived, (buf) => {
        const msg = decode(buf);
        if (!msg) return;

        if (msg.type === "STATE") setState(msg.data);

        if (msg.type === "DRAW") {
          // only host should execute draws
          if (roomRef.current && me.current && state.host === me.current) {
            draw();
          }
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

      // This is where it was likely failing for you; now you'll see the exact error.
      await room.connect(data.url, data.token);

      // 3) mark connected so UI advances immediately
      setConnected(true);

      // 4) initialize state (host if first)
      const next = clone(state);
      ensurePlayer(next, identity);

      if (!next.host) {
        next.host = identity;
        next.deck = shuffle(buildDeck());
      }

      setState(next);
      await send({ type: "STATE", data: next });

      // 5) ask for camera/mic AFTER UI is advanced
      // If permission denied, we still stay "connected" and show the error.
      try {
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        ensureTile(identity);
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
    setConnected(false);
  }

  /* =========================
     UI
  ========================= */

  const players = useMemo(() => Object.values(state.players), [state.players]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <div className="logo">KAD</div>
          <div>
            <div className="title">KAD Kings</div>
            <div className="sub">Video + synced deck + stats</div>
          </div>
        </div>

        <div className="status">
          <span className="dot" style={{ background: connected ? "rgba(34,197,94,0.9)" : "rgba(148,163,184,0.9)" }} />
          {connected ? "Connected" : "Not connected"}
        </div>
      </div>

      {!connected ? (
        <div className="card">
          <div className="field">
            <div>Room</div>
            <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="kad" />
          </div>

          <div className="field">
            <div>Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ty" />
          </div>

          <div className="row">
            <button className="btn primary" onClick={connect} disabled={joining}>
              {joining ? "Joining..." : "Join"}
            </button>
          </div>

          {errMsg ? (
            <div className="note" style={{ color: "rgba(248,113,113,0.95)" }}>
              {errMsg}
            </div>
          ) : (
            <div className="note">
              If Join does nothing, the error will show here.
            </div>
          )}
        </div>
      ) : (
        <div className="grid2">
          <div className="card">
            <div className="cardHead">
              <h2>Video</h2>
              <button className="btn danger small" onClick={disconnect}>
                Leave
              </button>
            </div>

            {errMsg ? (
              <div className="note" style={{ color: "rgba(248,113,113,0.95)" }}>
                {errMsg}
              </div>
            ) : null}

            <div ref={videoRef} className="videoGrid" />
            <div className="note">
              If you can’t see yourself: check browser permissions (camera/mic allowed).
            </div>
          </div>

          <div className="card">
            <div className="cardHead">
              <h2>Deck</h2>
              <span className="pill">Host: {state.host || "—"}</span>
            </div>

            <button className="deckBtn" onClick={draw}>
              <div className="deckFace">
                <div className="deckTop">KAD</div>
                <div className="deckMid">DRAW</div>
                <div className="deckBot">KINGS</div>
              </div>
            </button>

            <div className="currentCard">
              <div className="label">Current Card</div>
              <div className="cardText">{state.currentCard || "—"}</div>
            </div>

            <div className="statsBox">
              <div className="statsHead">
                <div>
                  <div className="label">Your drinks</div>
                  <div style={{ fontWeight: 900, fontSize: 20 }}>
                    {state.players[me.current]?.drinks ?? 0}
                  </div>
                </div>
                <div className="row tight">
                  <button className="btn small" onClick={() => changeDrink(-1)}>
                    -1
                  </button>
                  <button className="btn small primary" onClick={() => changeDrink(1)}>
                    +1
                  </button>
                </div>
              </div>

              <div className="label">Players</div>
              <div className="statsList">
                {players.map((p) => (
                  <div key={p.name} className="statRow">
                    <div style={{ fontWeight: 900 }}>{p.name}</div>
                    <div style={{ opacity: 0.9 }}>
                      🍺 {p.drinks} · 🃏 {p.cardsDrawn}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="footer">
              Tip: open the same room on a second phone to confirm real-time sync.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
