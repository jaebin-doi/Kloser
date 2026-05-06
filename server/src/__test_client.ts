// Throwaway manual test client for Day 1 verification.
// Run: npx tsx src/__test_client.ts
// Delete after Day 4 done — replaced by Playwright e2e.

import { io } from "socket.io-client";

const URL = "http://localhost:3001/calls";
const socket = io(URL, { query: { userId: "test-day1" }, transports: ["websocket"] });

socket.on("connect", async () => {
  console.log("[test] connected", socket.id);

  socket.emit("start_call", { customerId: "test-customer" }, (resp: unknown) => {
    console.log("[test] start_call ack", resp);
  });

  const sentAt = Date.now();
  socket.emit("text_chunk", { seq: 1, text: "안녕하세요 테스트", clientSentAt: sentAt });

  socket.on("transcript", (ev) => {
    const rtt = Date.now() - ev.clientSentAt;
    console.log("[test] transcript", ev, `rtt=${rtt}ms`);
    socket.emit("end_call", {}, (resp: unknown) => {
      console.log("[test] end_call ack", resp);
      socket.close();
      process.exit(0);
    });
  });

  socket.on("error", (err) => console.error("[test] error", err));
});

setTimeout(() => {
  console.error("[test] TIMEOUT — no transcript in 5s");
  process.exit(1);
}, 5000);
