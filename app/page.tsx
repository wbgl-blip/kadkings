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
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const d: string[] = [];
  for (const r of ranks) for (const s of suits) d.push(`${r}${s}`);
  return d;
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
    if (!root) return;

    let el = root.querySelector(`[data-id="${id}"]`) as HTMLDivElement;

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

  /* =========================
     NETWORK
  ========================= */

  async function send(msg: Msg) {
    const r = roomRef.current;
    if (!r) return;

    await r.localParticipant.publishData(
      encode(msg),
      { reliable: true }
    );
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
      send({ type: "DRAW" });
      return;
    }

    const next = structuredClone(state);

    if (!next.deck.length) {
      next.deck = shuffle(buildDeck());
    }

    const card = next.deck.shift() || null;

    next.currentCard = card;

    ensurePlayer(next, me.current);
    next.players[me.current].cardsDrawn++;

    setState(next);
    send({ type: "STATE", data: next });
  }

  function changeDrink(n: number) {
    const next = structuredClone(state);

    ensurePlayer(next, me.current);

    next.players[me.current].drinks =
      Math.max(0, next.players[me.current].drinks + n);

    setState(next);

    send({
      type: "UPDATE",
      id: me.current,
      patch: { drinks: next.players[me.current].drinks }
    });
  }

  /* =========================
     CONNECT
  ========================= */

  async function connect() {
    if (!roomCode || !name) return alert("Enter name + room");

    const res = await fetch(
      `/api/token?room=${roomCode}&name=${name}`
    );

    const data = await res.json();

    const room = new Room();
    roomRef.current = room;

    me.current = name;

    room.on(RoomEvent.TrackSubscribed, (track, _, p) => {
      const tile = ensureTile(p.identity);
      if (!tile) return;

      if (track.kind === Track.Kind.Video) {
        track.attach(tile.querySelector("video")!);
      }
    });

    room.on(RoomEvent.DataReceived, (buf) => {
      const msg = decode(buf);
      if (!msg) return;

      if (msg.type === "STATE") {
        setState(msg.data);
      }

      if (msg.type === "DRAW") {
        if (state.host === me.current) draw();
      }

      if (msg.type === "UPDATE") {
        setState((s) => {
          const n = structuredClone(s);
          ensurePlayer(n, msg.id);
          Object.assign(n.players[msg.id], msg.patch);
          return n;
        });
      }
    });

    await room.connect(data.url, data.token);

    const next = structuredClone(state);

    ensurePlayer(next, name);

    if (!next.host) {
      next.host = name;
      next.deck = shuffle(buildDeck());
    }

    setState(next);
    send({ type: "STATE", data: next });

    setConnected(true);

    await room.localParticipant.setCameraEnabled(true);
    await room.localParticipant.setMicrophoneEnabled(true);

    ensureTile(name);
  }

  /* =========================
     UI
  ========================= */

  const players = useMemo(
    () => Object.values(state.players),
    [state.players]
  );

  return (
    <div className="app">
      <h2>KAD Kings</h2>

      {!connected ? (
        <div className="card">
          <input
            placeholder="Room"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
          />

          <input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <button className="btn primary" onClick={connect}>
            Join
          </button>
        </div>
      ) : (
        <>
          <div ref={videoRef} className="videoGrid" />

          <div className="card">
            <button className="deckBtn" onClick={draw}>
              <div className="deckFace">DRAW</div>
            </button>

            <h1>{state.currentCard || "—"}</h1>

            <div className="row">
              <button className="btn" onClick={() => changeDrink(1)}>
                + Drink
              </button>

              <button className="btn" onClick={() => changeDrink(-1)}>
                - Drink
              </button>
            </div>

            {players.map((p) => (
              <div key={p.name} className="statRow">
                {p.name} — {p.drinks}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
