import { EmailMessage } from "cloudflare:email";

const MAX = { name: 100, email: 254, phone: 40, message: 5000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Strip CR/LF so user input can never inject extra email headers.
const oneLine = (s) => s.replace(/[\r\n]+/g, " ").trim();

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/(.{76})/g, "$1\r\n");
};

async function verifyTurnstile(token, secret, ip) {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await res.json();
  return data.success === true;
}

async function handleContact(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: "Forbidden" }, 403);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  // Honeypot: real users never see or fill this field. Pretend success to bots.
  if (form.get("website")) return json({ ok: true });

  const get = (k) => String(form.get(k) ?? "").trim();
  const name = oneLine(get("name"));
  const email = oneLine(get("email"));
  const phone = oneLine(get("phone"));
  const message = get("message");

  if (!name || !email || !message) return json({ error: "Please fill in your name, email and message." }, 400);
  if (name.length > MAX.name || email.length > MAX.email || phone.length > MAX.phone || message.length > MAX.message) {
    return json({ error: "One of the fields is too long." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);

  const token = get("cf-turnstile-response");
  const ok = token && (await verifyTurnstile(token, env.TURNSTILE_SECRET, request.headers.get("CF-Connecting-IP")));
  if (!ok) return json({ error: "Verification failed. Please try again." }, 400);

  const subject = `Website inquiry from ${name}`;
  const text =
    `Name: ${name}\r\nEmail: ${email}\r\nPhone: ${phone || "(not provided)"}\r\n\r\n${message.replace(/\r?\n/g, "\r\n")}\r\n`;

  const raw = [
    `From: Website Contact Form <${env.FROM_ADDRESS}>`,
    `To: ${env.TO_ADDRESS}`,
    `Reply-To: ${email}`,
    `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@scottblayney.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
  ].join("\r\n");

  try {
    await env.EMAIL.send(new EmailMessage(env.FROM_ADDRESS, env.TO_ADDRESS, raw));
  } catch (err) {
    console.error("send failed", err);
    return json({ error: "Sorry, your message could not be sent. Please try again later." }, 500);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/contact") return handleContact(request, env);
    return env.ASSETS.fetch(request);
  },
};
