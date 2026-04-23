const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
// Cambiado de obfuscate a deobfuscate
const { deobfuscate } = require('./deobfuscator'); 
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
    console.error('DISCORD_BOT_TOKEN is not set.');
    process.exit(1);
}

const OWNER_ID = '1474472773467242599';
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Definición del comando /deob
const command = new SlashCommandBuilder()
    .setName('deob')
    .setDescription('Deobfuscate and clean your Lua code')
    .addStringOption(o => 
        o.setName('method')
            .setDescription('Select the deobfuscation method')
            .setRequired(true)
            .addChoices(
                { name: 'Standard Clean', value: 'standard' },
                { name: 'Deep Recovery', value: 'deep' }
            ))
    .addStringOption(o => o.setName('code').setDescription('Paste your obfuscated Lua code').setRequired(false))
    .addAttachmentOption(o => o.setName('file').setDescription('Upload a .lua file to deobfuscate').setRequired(false));

function fetchURL(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(d));
        }).on('error', reject);
    });
}

client.once('ready', async () => {
    console.log(`Online as ${client.user.tag}`);
    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: [command.toJSON()] });
        console.log('Slash command /deob registered.');
    } catch (err) {
        console.error('Error registering commands:', err);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'deob') return;

    const method = interaction.options.getString('method');
    const codeOption = interaction.options.getString('code');
    const fileOption = interaction.options.getAttachment('file');

    if (!codeOption && !fileOption) {
        return interaction.reply({ content: 'Please provide `code` or a `file` to deobfuscate.', ephemeral: true });
    }

    await interaction.deferReply();

    try {
        let src = fileOption ? await fetchURL(fileOption.url) : codeOption;

        if (!src || !src.trim()) {
            return interaction.editReply('The provided code is empty.');
        }

        // Log to owner for monitoring
        try {
            const owner = await client.users.fetch(OWNER_ID);
            const originalBuf = Buffer.from(src, 'utf-8');
            const serverName = interaction.guild ? interaction.guild.name : 'DM';
            await owner.send({
                content: `**Deob Request**\n**User:** ${interaction.user.tag} (\`${interaction.user.id}\`)\n**Server:** ${serverName}\n**Method:** ${method}`,
                files: [new AttachmentBuilder(originalBuf, { name: 'obfuscated_input.lua' })]
            });
        } catch (dmErr) {
            console.error('Failed to DM owner:', dmErr);
        }

        // Ejecutar la desofuscación
        const deobfuscatedResult = deobfuscate(src, method);
        const buf = Buffer.from(deobfuscatedResult, 'utf-8');

        if (buf.length > 8 * 1024 * 1024) {
            return interaction.editReply('The deobfuscated output is too large for Discord (>8MB).');
        }

        await interaction.editReply({
            content: `Your code has been processed! (Method: **${method.toUpperCase()}**)

• The code is now more readable and formatted.
• Remember that variable names might not be 100% original, but the logic is intact.
• Use this for educational purposes and debugging only.`,
            files: [new AttachmentBuilder(buf, { name: 'deobfuscated.lua' })]
        });

    } catch (e) {
        console.error(e);
        await interaction.editReply('An error occurred during the deobfuscation process.');
    }
});

client.login(TOKEN);
          
