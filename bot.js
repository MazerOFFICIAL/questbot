import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";

const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  USER_TOKEN: process.env.USER_TOKEN || "",
  CHANNEL_ID: process.env.CHANNEL_ID || "",
  ROLE_ID: "1504918783528144917",
  CHECK_INTERVAL: 2 * 60 * 1000,
  DB_FILE: "./sent_quests.json",
};

// Persistent store for already-notified quest IDs
function loadSent() {
  try {
    return new Set(JSON.parse(fs.readFileSync(CONFIG.DB_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

function saveSent(set) {
  fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify([...set], null, 2));
}

const sentQuests = loadSent();

// Fetch active quests via the internal Discord client endpoint
async function fetchQuests() {
  const res = await fetch("https://discord.com/api/v9/quests/@me", {
    headers: {
      Authorization: CONFIG.USER_TOKEN,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9163 Chrome/124.0.6367.243 Electron/30.2.0 Safari/537.36",
      "X-Super-Properties": Buffer.from(
        JSON.stringify({
          os: "Windows",
          browser: "Discord Client",
          release_channel: "stable",
          client_version: "1.0.9163",
          os_version: "10.0.22631",
          system_locale: "en-US",
          client_build_number: 312017,
        })
      ).toString("base64"),
    },
  });

  if (res.status === 401) {
    console.error("User token is invalid or expired");
    return [];
  }

  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    console.warn(`Rate limited, retrying in ${retry}s`);
    return [];
  }

  if (!res.ok) {
    console.error(`API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = await res.json();

  return (data.quests || []).map((q) => {
    const cfg = q.config || {};
    const msg = cfg.messages || {};
    return {
      id: q.id,
      title: msg.quest_name || "New Quest",
      reward: msg.reward_name_with_article || msg.reward_name || null,
      game: msg.game_title || null,
      description: msg.quest_description || null,
      streamDuration: cfg.stream_duration_requirement_minutes || null,
      expiresAt: cfg.expires_at || null,
      url: `https://discord.com/quests/${q.id}`,
    };
  });
}

// Build and send the notification embed
async function notifyQuest(channel, quest) {
  const embed = new EmbedBuilder()
    .setTitle(quest.title)
    .setURL(quest.url)
    .setColor(0x5865f2)
    .setTimestamp();

  if (quest.description) embed.setDescription(quest.description);

  const fields = [];
  if (quest.reward) fields.push({ name: "Reward", value: quest.reward, inline: true });
  if (quest.game) fields.push({ name: "Game", value: quest.game, inline: true });
  if (quest.streamDuration)
    fields.push({ name: "Stream", value: `${quest.streamDuration} min`, inline: true });
  if (quest.expiresAt) {
    const ts = Math.floor(new Date(quest.expiresAt).getTime() / 1000);
    fields.push({ name: "Expires", value: `<t:${ts}:R>`, inline: true });
  }

  if (fields.length) embed.addFields(fields);

  await channel.send({
    content: `<@&${CONFIG.ROLE_ID}>\n${quest.url}`,
    embeds: [embed],
  });
}

// Poll loop — runs on interval, diffs against local state
async function check() {
  try {
    const quests = await fetchQuests();
    const newOnes = quests.filter((q) => !sentQuests.has(q.id));

    if (!newOnes.length) return;

    const channel = await bot.channels.fetch(CONFIG.CHANNEL_ID);
    if (!channel) {
      console.error("Channel not found, check CHANNEL_ID");
      return;
    }

    for (const quest of newOnes) {
      await notifyQuest(channel, quest);
      sentQuests.add(quest.id);
      console.log(`Sent: ${quest.title} (${quest.id})`);
    }

    saveSent(sentQuests);
  } catch (err) {
    console.error("Check failed:", err.message);
  }
}

// Bootstrap
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("ready", () => {
  console.log(`Bot ready: ${bot.user.tag}`);
  check();
  setInterval(check, CONFIG.CHECK_INTERVAL);
});

for (const key of ["BOT_TOKEN", "USER_TOKEN", "CHANNEL_ID"]) {
  if (!CONFIG[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

bot.login(CONFIG.BOT_TOKEN);
