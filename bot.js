import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";

const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  USER_TOKEN: process.env.USER_TOKEN || "",
  CHANNEL_ID: process.env.CHANNEL_ID || "",
  ROLE_ID: "1504918783528144917",
  CHECK_INTERVAL: 2 * 60 * 1000,
  DB_FILE: "./sent_quests.json",
  PREFIX: "!",
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
let cachedQuests = [];
let lastFetch = 0;

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
  console.log(`API response keys: ${Object.keys(data)}`);
  console.log(`Quests array length: ${(data.quests || []).length}`);
  if (data.quests?.length) console.log(`First quest ID: ${data.quests[0].id}`);
  if (!data.quests?.length) console.log(`Raw response: ${JSON.stringify(data).slice(0, 500)}`);

  const quests = (data.quests || []).map((q) => {
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
      completed: q.user_status?.completed_at != null,
      progress: q.user_status?.progress || 0,
    };
  });

  cachedQuests = quests;
  lastFetch = Date.now();
  return quests;
}

// Get quests with short cache to avoid spamming API on commands
async function getQuests() {
  if (Date.now() - lastFetch < 30_000 && cachedQuests.length) return cachedQuests;
  return fetchQuests();
}

// Build embed for a single quest
function questEmbed(quest) {
  const embed = new EmbedBuilder()
    .setTitle(quest.title)
    .setURL(quest.url)
    .setColor(quest.completed ? 0x57f287 : 0x5865f2)
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
  if (quest.completed) {
    fields.push({ name: "Status", value: "Completed", inline: true });
  }

  if (fields.length) embed.addFields(fields);
  return embed;
}

// Count rewards from a list of quests
function countRewards(quests) {
  const rewards = {};
  for (const q of quests) {
    const name = q.reward || "Unknown reward";
    rewards[name] = (rewards[name] || 0) + 1;
  }
  return rewards;
}

function rewardsToString(rewards) {
  return Object.entries(rewards)
    .map(([name, count]) => `• **${name}** x${count}`)
    .join("\n") || "Nothing found";
}

// Command handlers
const commands = {
  async help(message) {
    const embed = new EmbedBuilder()
      .setTitle("Quest Bot Commands")
      .setColor(0x5865f2)
      .setDescription([
        `\`${CONFIG.PREFIX}quests\` — all active quests`,
        `\`${CONFIG.PREFIX}new\` — new unseen quests`,
        `\`${CONFIG.PREFIX}rewards\` — rewards from all active quests`,
        `\`${CONFIG.PREFIX}newrewards\` — rewards from new quests only`,
        `\`${CONFIG.PREFIX}done\` — completed quests`,
        `\`${CONFIG.PREFIX}stats\` — quick stats overview`,
        `\`${CONFIG.PREFIX}hi\` — say hello`,
        `\`${CONFIG.PREFIX}help\` — this message`,
      ].join("\n"));

    await message.reply({ embeds: [embed] });
  },

  async hi(message) {
    const hours = new Date().getHours();
    let greeting = "Hey";
    if (hours < 6) greeting = "Night owl";
    else if (hours < 12) greeting = "Good morning";
    else if (hours < 18) greeting = "Good afternoon";
    else greeting = "Good evening";

    await message.reply(`${greeting}, ${message.author.username}! Use \`${CONFIG.PREFIX}help\` to see what I can do.`);
  },

  // All active quests
  async quests(message) {
    const quests = await getQuests();
    if (!quests.length) return message.reply("No active quests right now.");

    const embeds = quests.slice(0, 10).map(questEmbed);
    await message.reply({
      content: `**${quests.length} active quest(s):**`,
      embeds,
    });
  },

  // New quests (not yet sent/seen)
  async new(message) {
    const quests = await getQuests();
    const newOnes = quests.filter((q) => !sentQuests.has(q.id));

    if (!newOnes.length) return message.reply("No new quests since last check.");

    const embeds = newOnes.slice(0, 10).map(questEmbed);
    await message.reply({
      content: `**${newOnes.length} new quest(s):**`,
      embeds,
    });
  },

  // Rewards from all active quests
  async rewards(message) {
    const quests = await getQuests();
    if (!quests.length) return message.reply("No active quests right now.");

    const rewards = countRewards(quests);
    const embed = new EmbedBuilder()
      .setTitle("All Quest Rewards")
      .setColor(0xfee75c)
      .setDescription(rewardsToString(rewards))
      .setFooter({ text: `From ${quests.length} active quest(s)` });

    await message.reply({ embeds: [embed] });
  },

  // Rewards from new quests only
  async newrewards(message) {
    const quests = await getQuests();
    const newOnes = quests.filter((q) => !sentQuests.has(q.id));

    if (!newOnes.length) return message.reply("No new quests to count rewards from.");

    const rewards = countRewards(newOnes);
    const embed = new EmbedBuilder()
      .setTitle("New Quest Rewards")
      .setColor(0x57f287)
      .setDescription(rewardsToString(rewards))
      .setFooter({ text: `From ${newOnes.length} new quest(s)` });

    await message.reply({ embeds: [embed] });
  },

  // Completed quests
  async done(message) {
    const quests = await getQuests();
    const completed = quests.filter((q) => q.completed);

    if (!completed.length) return message.reply("No completed quests yet.");

    const embeds = completed.slice(0, 10).map(questEmbed);
    await message.reply({
      content: `**${completed.length} completed quest(s):**`,
      embeds,
    });
  },

  // Quick stats
  async stats(message) {
    const quests = await getQuests();
    const completed = quests.filter((q) => q.completed).length;
    const pending = quests.length - completed;
    const newOnes = quests.filter((q) => !sentQuests.has(q.id)).length;

    const embed = new EmbedBuilder()
      .setTitle("Quest Stats")
      .setColor(0x5865f2)
      .addFields(
        { name: "Active", value: `${quests.length}`, inline: true },
        { name: "Completed", value: `${completed}`, inline: true },
        { name: "Pending", value: `${pending}`, inline: true },
        { name: "New (unseen)", value: `${newOnes}`, inline: true },
      );

    await message.reply({ embeds: [embed] });
  },
};

// Auto-notify loop — posts new quests to the configured channel
async function autoCheck() {
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
      await channel.send({
        content: `<@&${CONFIG.ROLE_ID}>\n${quest.url}`,
        embeds: [questEmbed(quest)],
      });
      sentQuests.add(quest.id);
      console.log(`Sent: ${quest.title} (${quest.id})`);
    }

    saveSent(sentQuests);
  } catch (err) {
    console.error("Auto-check failed:", err.message);
  }
}

// Bootstrap
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Command router
bot.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CONFIG.PREFIX)) return;

  const cmd = message.content.slice(CONFIG.PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
  const handler = commands[cmd];

  if (handler) {
    try {
      await handler(message);
    } catch (err) {
      console.error(`Command error (${cmd}):`, err.message);
      await message.reply("Something went wrong, check the logs.").catch(() => {});
    }
  }
});

bot.once("ready", () => {
  console.log(`Bot ready: ${bot.user.tag}`);
  autoCheck();
  setInterval(autoCheck, CONFIG.CHECK_INTERVAL);
});

for (const key of ["BOT_TOKEN", "USER_TOKEN", "CHANNEL_ID"]) {
  if (!CONFIG[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

bot.login(CONFIG.BOT_TOKEN);
