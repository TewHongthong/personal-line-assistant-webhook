import crypto from "crypto";

// fetch is available in Vercel Node 18+; if not, you can import node-fetch
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// endpoint of retriever service
const RETRIEVER_ENDPOINT = process.env.RETRIEVER_ENDPOINT || "";

function verifySignature(body, signature) {
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const bodyBuffer = await new Promise((resolve, reject) => {
    let data = [];
    req.on("data", chunk => data.push(chunk));
    req.on("end", () => resolve(Buffer.concat(data)));
    req.on("error", err => reject(err));
  });
  const bodyString = bodyBuffer.toString("utf8");
  const signature = req.headers["x-line-signature"];

  if (!verifySignature(bodyString, signature)) {
    console.warn("Invalid signature");
    return res.status(400).send("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(bodyString);
  } catch (e) {
    return res.status(400).send("Bad JSON");
  }

  const events = payload.events || [];
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userText = event.message.text;
      const replyToken = event.replyToken;

      let contexts = [];
      try {
        const retrievalResp = await fetch(
          RETRIEVER_ENDPOINT + "/query",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: userText, top_k: 3 }),
          }
        );
        const j = await retrievalResp.json();
        contexts = j.contexts || [];
      } catch (err) {
        console.error("Retrieval error", err);
      }

      const prompt = `ใช้ความรู้ด้านล่างประกอบการตอบคำถามต่อไปนี้

Context:
${contexts.join("\n---\n")}

คำถาม: ${userText}

ตอบอย่างกระชับและเป็นประโยชน์:`;

      let answer = "ขอโทษ, ขณะนี้ไม่สามารถตอบได้";
      try {
        const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: "คุณเป็นผู้ช่วยส่วนตัวที่ใช้ฐานความรู้ของผู้ใช้",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 800,
          }),
        });
        const data = await orResp.json();
        answer = data.choices?.[0]?.message?.content || answer;
      } catch (err) {
        console.error("OpenRouter error", err);
      }

      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: "text", text: answer }],
        }),
      });
    }
  }

  return res.status(200).send("ok");
}
