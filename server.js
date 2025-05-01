const WebSocket = require("ws");
const http = require("http");
const express = require("express");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();

const broadcastToHost = (room, message) => {
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    room.host.send(JSON.stringify(message));
  }
};

const broadcastToPlayers = (room, message) => {
  room.players.forEach((player) => {
    if (player.connected && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  });
};

const updateLeaderboard = (room) => {
  const leaderboard = room.players
    .filter((player) => player.connected)
    .map((player) => ({
      name: player.name,
      score: player.score,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  console.log("WebSocket: Отправляем лидерборд:", leaderboard);
  broadcastToPlayers(room, {
    event: "question-results",
    payload: { leaderboard },
  });
  broadcastToHost(room, {
    event: "question-results",
    payload: { leaderboard },
  });
};

wss.on("connection", (ws, req) => {
  const roomId = req.url.slice(1);
  console.log(`WebSocket: Новое соединение в комнате: ${roomId}`);

  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      players: [],
      currentQuestion: null,
      questionTimer: null,
    });
  }

  const room = rooms.get(roomId);

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
      console.log("WebSocket: Получено сообщение:", data);
    } catch (err) {
      console.error("WebSocket: Ошибка парсинга сообщения:", err);
      return;
    }

    if (data.event === "host-joined") {
      room.host = ws;
      console.log(`WebSocket: Хост подключился к комнате: ${roomId}`);
      broadcastToHost(room, {
        event: "players-updated",
        payload: room.players
          .filter((p) => p.connected)
          .map((p) => ({
            name: p.name,
            score: p.score,
          })),
      });
    } else if (data.event === "player-joined") {
      const { name, sessionId } = data.payload;
      const existingPlayer = room.players.find(
        (p) => p.name === name && p.sessionId === sessionId
      );

      if (existingPlayer) {
        existingPlayer.ws = ws;
        existingPlayer.connected = true;
        console.log(`WebSocket: Игрок переподключился: ${name}`);
      } else {
        room.players.push({
          name,
          sessionId,
          ws,
          score: 0,
          connected: true,
        });
        console.log(`WebSocket: Новый игрок добавлен: ${name}`);
      }

      broadcastToHost(room, {
        event: "players-updated",
        payload: room.players
          .filter((p) => p.connected)
          .map((p) => ({
            name: p.name,
            score: p.score,
          })),
      });
    } else if (data.event === "new-question") {
      room.currentQuestion = data.payload;
      room.currentQuestion.responses = new Map();
      console.log("WebSocket: Новый вопрос:", room.currentQuestion.question);

      broadcastToPlayers(room, {
        event: "new-question",
        payload: room.currentQuestion,
      });

      if (room.questionTimer) {
        clearTimeout(room.questionTimer);
      }

      room.questionTimer = setTimeout(() => {
        console.log("WebSocket: Время вопроса истекло");
        updateLeaderboard(room);
        room.currentQuestion = null;
      }, (room.currentQuestion.timerDuration || 15) * 1000);
    } else if (data.event === "player-answer") {
      const { name, score, isCorrect, sessionId } = data.payload;
      console.log("WebSocket: Получен ответ от игрока:", {
        name,
        score,
        isCorrect,
        sessionId,
      });

      const player = room.players.find(
        (p) => p.name === name && p.sessionId === sessionId && p.connected
      );

      if (!player) {
        console.warn(`WebSocket: Игрок не найден или не подключён: ${name}`);
        ws.send(
          JSON.stringify({
            event: "access-denied",
            payload: { reason: "invalid-name" },
          })
        );
        return;
      }

      if (!room.currentQuestion) {
        console.warn(`WebSocket: Ответ получен, но вопроса нет: ${name}`);
        return;
      }

      if (!room.currentQuestion.responses.has(name)) {
        player.score += score;
        room.currentQuestion.responses.set(name, { isCorrect, score });
        console.log(`WebSocket: Счёт игрока обновлён:`, {
          name,
          score: player.score,
        });
        updateLeaderboard(room);
      } else {
        console.warn(`WebSocket: Игрок уже ответил: ${name}`);
      }
    } else if (data.event === "question-timeout") {
      const { name, sessionId } = data.payload;
      console.log(`WebSocket: Таймаут ответа от игрока: ${name}`);
      if (room.currentQuestion && !room.currentQuestion.responses.has(name)) {
        room.currentQuestion.responses.set(name, {
          isCorrect: false,
          score: 0,
        });
      }
    } else if (data.event === "game-over") {
      clearTimeout(room.questionTimer);
      const leaderboard = room.players
        .filter((p) => p.connected)
        .map((p) => ({ name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      console.log(
        "WebSocket: Игра окончена, финальный лидерборд:",
        leaderboard
      );
      broadcastToPlayers(room, {
        event: "game-over",
        payload: { leaderboard },
      });
      broadcastToHost(room, { event: "game-over", payload: { leaderboard } });
      room.currentQuestion = null;
    }
  });

  ws.on("close", () => {
    if (ws === room.host) {
      console.log(`WebSocket: Хост отключился от комнаты: ${roomId}`);
      room.host = null;
    } else {
      const player = room.players.find((p) => p.ws === ws);
      if (player) {
        player.connected = false;
        console.log(`WebSocket: Игрок отключился: ${player.name}`);
        broadcastToHost(room, {
          event: "players-updated",
          payload: room.players
            .filter((p) => p.connected)
            .map((p) => ({
              name: p.name,
              score: p.score,
            })),
        });
      }
    }
    console.log(
      "WebSocket: Игрок отключился, обновлённый список игроков:",
      room.players
    );
  });
});

// ✅ Используем PORT от Render
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`WebSocket сервер запущен на порту ${PORT}`);
});

app.use(express.static("public"));
