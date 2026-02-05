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

function parseCard(card: string | null) {
  if (!card) return { rank: "", suit: "", isRed: false, ok: false };

  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  const isRed = suit === "♥" || suit === "♦";

  const ok =
    (rank === "A" ||
      rank === "J" ||
      rank === "Q" ||
      rank === "K" ||
      ["2", "3", "4", "5", "6", "7", "8", "9", "10"].includes(rank)) &&
    ["♠", "♥", "♦", "♣"].includes(suit);

  return { rank, suit, isRed, ok };
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
  const [name, setName] = useState("");

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [isFullscreen, setIsFullscreen] = useState(false);

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

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    onFs();
    document.addEventListener("fullscreenchange", onFs);
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
      // ignore
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
    if (!gs.players[id]) gs.players[id] = { name: id, drinks: 0, cardsDrawn: 0 };
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
    await send({ type: "UPDATE", id: me.current, patch: { drinks: next.players[me.current].drinks } });
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
        if (track.kind === Track.Kind.Video) track.attach(tile.querySelector("video")!);
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
          if (roomRef.current && me.current && current.host === me.current) draw();
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

    setState({ host: null, deck: [], currentCard: null, players: {} });
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

  useEffect(() => {
    if (!connected) return;
    reorderTiles(orderedPlayers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, orderedPlayers.join("|")]);

  const effectiveCount = Math.min(6, Math.max(1, orderedPlayers.length || 1));
  const layout = computeVideoLayout(effectiveCount);

  const card = parseCard(state.currentCard);
  const cardColorClass = card.isRed ? "isRed" : "isBlack";

  return (
    <div className="appB">
      <div className="topbarB">
        <div className="brandB">
          <div className="logoB">KAD</div>
          <div style={{ minWidth: 0 }}>
            <div className="titleB">KAD Kings</div>
            <div className="subB">Players always visible · one-screen</div>
          </div>
        </div>

        <div className="topRightB">
          <button className="fsBtnB" onClick={toggleFullscreen} type="button">
            {isFullscreen ? "Exit" : "Fullscreen"}
          </button>

          <div className="statusB">
            <span className="dotB" style={{ background: connected ? "rgba(34,197,94,0.9)" : "rgba(148,163,184,0.9)" }} />
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
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ty" />
          </div>

          <div className="rowB">
            <button className="btnB btnPrimaryB" onClick={connect} disabled={joining} type="button">
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
                <button className="btnB btnDangerB btnTinyB" onClick={disconnect} type="button">
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

          <div className="bottomBarB">
            {/* CARD-FIRST DRAW AREA */}
            <div className="cardB deckMiniB">
              <button className="drawComboB" onClick={draw} type="button">
                <div className="drawLeftB">
                  <div className="cardStackB" aria-hidden="true" />
                  <div className="cardStackB stack2" aria-hidden="true" />

                  <div className="bigCardShellB">
                    {card.ok ? (
                      <div className={`bigCardB ${cardColorClass}`}>
                        <div className="bigCornerTL">
                          <span className="bigRank">{card.rank}</span>
                          <span className="bigSuit">{card.suit}</span>
                        </div>

                        <div className="bigSuitCenter">{card.suit}</div>

                        <div className="bigCornerBR">
                          <span className="bigRank">{card.rank}</span>
                          <span className="bigSuit">{card.suit}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="bigBackB">
                        <div className="bigBackTop">KAD</div>
                        <div className="bigBackMid">KINGS</div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="drawRightB">
                  <div className="drawTitleB">DRAW</div>
                  <div className="drawSubB">{state.host === me.current ? "Tap to draw" : "Tap to request draw"}</div>

                  <div className="drawMetaRowB">
                    <div className="metaPillB">Remaining: {state.deck.length}</div>
                    <div className="metaPillB">{state.host === me.current ? "HOST" : "GUEST"}</div>
                  </div>
                </div>
              </button>
            </div>

            {/* STATS */}
            <div className="cardB statsMiniB">
              <div className="yourDrinksRowB">
                <div>
                  <div className="labelMiniB">Your drinks</div>
                  <div className="drinkNumB">{state.players[me.current]?.drinks ?? 0}</div>
                </div>
                <div className="btnGroupB">
                  <button className="btnB btnTinyB" onClick={() => changeDrink(-1)} type="button">
                    -1
                  </button>
                  <button className="btnB btnPrimaryB btnTinyB" onClick={() => changeDrink(1)} type="button">
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
