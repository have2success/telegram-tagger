const TelegramBot = require('node-telegram-bot-api');
const NodeID3 = require('node-id3');

// Replace with your real token from BotFather
const token = '8926510696:AAF5zWdI_NuVyzSA_fXQvQic7C_LaNfVIyc';
const bot = new TelegramBot(token, { polling: true });

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
// userLang[chatId]   -> 'en' | 'ru'          (persists across the whole session)
// userStates[chatId] -> {
//   stage: 'collecting' | 'cover' | 'tagging',
//   queue: [{ audioId, fileName }],
//   currentIndex: number,
//   coverId: string | null
// }
const userLang = {};
const userStates = {};

// ---------------------------------------------------------------------------
// Button labels per language (defined first so TEXT can reference them)
// ---------------------------------------------------------------------------
const BTN = {
    en: { sendAudio: '🎵 Send Audio (you can send multiple)', done: '✅ Done - Start Tagging', skip: '⏭ Skip Cover', cancel: '❌ Cancel' },
    ru: { sendAudio: '🎵 Отправить аудио (можно несколько)', done: '✅ Готово - начать разметку', skip: '⏭ Пропустить обложку', cancel: '❌ Отмена' },
};

// ---------------------------------------------------------------------------
// Text per language
// ---------------------------------------------------------------------------
const TEXT = {
    en: {
        chooseLang: 'Please choose your language 👇',
        welcome: (n) =>
            `👋 Welcome to Audio Tag Editor Bot!\n\nSend or forward one or more MP3 files, then press "${BTN.en.done}" when you're ready to tag them.${n ? `\n\nCurrently in queue: ${n}` : ''}`,
        audioReceived: (n) =>
            `🎶 Audio received! Total in queue: ${n}.\n\nSend more, or press "${BTN.en.done}" to start tagging.`,
        queueEmpty: '⚠️ Your queue is empty. Send an MP3 file first.',
        askCover: (name) =>
            `🖼️ [${name}]\nSend a cover photo for this track, or press "${BTN.en.skip}".`,
        coverSaved: (name) =>
            `✅ Cover saved for [${name}].\n\nNow reply with the track info: Title - Artist`,
        coverSkipped: (name) =>
            `⏩ Cover skipped for [${name}].\n\nNow reply with the track info: Title - Artist`,
        badFormat: '⚠️ Format incorrect. Please send: Title - Artist',
        processing: (name) => `⚙️ Tagging "${name}" in memory...`,
        fileDone: (remaining) =>
            remaining > 0
                ? `✅ Done! ${remaining} file(s) left in the queue.`
                : '✅ All files tagged! Send more MP3s to start a new batch.',
        error: '❌ Error processing file. Skipping to next.',
        cancelled: '❌ Cancelled. Queue cleared.',
        nothingToCancel: 'Nothing to cancel right now.',
    },
    ru: {
        chooseLang: 'Пожалуйста, выберите язык 👇',
        welcome: (n) =>
            `👋 Добро пожаловать в Audio Tag Editor Bot!\n\nОтправьте или перешлите один или несколько MP3-файлов, затем нажмите «${BTN.ru.done}», когда будете готовы их обработать.${n ? `\n\nСейчас в очереди: ${n}` : ''}`,
        audioReceived: (n) =>
            `🎶 Аудио получено! Всего в очереди: ${n}.\n\nОтправьте ещё или нажмите «${BTN.ru.done}», чтобы начать разметку.`,
        queueEmpty: '⚠️ Очередь пуста. Сначала отправьте MP3-файл.',
        askCover: (name) =>
            `🖼️ [${name}]\nОтправьте фото обложки для этого трека или нажмите «${BTN.ru.skip}».`,
        coverSaved: (name) =>
            `✅ Обложка сохранена для [${name}].\n\nТеперь отправьте данные трека: Название - Исполнитель`,
        coverSkipped: (name) =>
            `⏩ Обложка пропущена для [${name}].\n\nТеперь отправьте данные трека: Название - Исполнитель`,
        badFormat: '⚠️ Неверный формат. Отправьте так: Название - Исполнитель',
        processing: (name) => `⚙️ Обработка "${name}" в памяти...`,
        fileDone: (remaining) =>
            remaining > 0
                ? `✅ Готово! Осталось файлов в очереди: ${remaining}.`
                : '✅ Все файлы обработаны! Отправьте новые MP3, чтобы начать заново.',
        error: '❌ Ошибка обработки файла. Переходим к следующему.',
        cancelled: '❌ Отменено. Очередь очищена.',
        nothingToCancel: 'Сейчас нечего отменять.',
    },
};

function t(chatId) {
    return TEXT[userLang[chatId] || 'en'];
}
function btn(chatId) {
    return BTN[userLang[chatId] || 'en'];
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------
function mainKeyboard(chatId) {
    const b = btn(chatId);
    return {
        reply_markup: {
            keyboard: [[b.sendAudio], [b.done]],
            resize_keyboard: true,
        },
    };
}

function taggingKeyboard(chatId) {
    const b = btn(chatId);
    return {
        reply_markup: {
            keyboard: [[b.skip], [b.cancel]],
            resize_keyboard: true,
        },
    };
}

function languageInlineKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🇷🇺 Русский', callback_data: 'lang_ru' },
                    { text: '🇬🇧 English', callback_data: 'lang_en' },
                ],
            ],
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState(chatId) {
    delete userStates[chatId];
}

function getQueueState(chatId) {
    if (!userStates[chatId] || userStates[chatId].stage !== 'collecting') {
        userStates[chatId] = { stage: 'collecting', queue: [], currentIndex: 0, coverId: null };
    }
    return userStates[chatId];
}

async function startTaggingNext(chatId) {
    const state = userStates[chatId];
    if (!state || state.currentIndex >= state.queue.length) {
        // Batch finished
        resetState(chatId);
        await bot.sendMessage(chatId, t(chatId).fileDone(0), mainKeyboard(chatId));
        return;
    }
    state.stage = 'cover';
    state.coverId = null;
    const current = state.queue[state.currentIndex];
    await bot.sendMessage(chatId, t(chatId).askCover(current.fileName), taggingKeyboard(chatId));
}

async function processCurrentFile(chatId, title, artist) {
    const state = userStates[chatId];
    const current = state.queue[state.currentIndex];

    await bot.sendMessage(chatId, t(chatId).processing(current.fileName));

    try {
        const audioLink = await bot.getFileLink(current.audioId);
        const audioRes = await fetch(audioLink);
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

        const tags = { title, artist };

        if (state.coverId) {
            const coverLink = await bot.getFileLink(state.coverId);
            const coverRes = await fetch(coverLink);
            tags.image = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: 'Cover',
                imageBuffer: Buffer.from(await coverRes.arrayBuffer()),
            };
        }

        const taggedBuffer = NodeID3.write(tags, audioBuffer);

        await bot.sendAudio(chatId, taggedBuffer, {}, {
            filename: `${artist} - ${title}.mp3`,
            contentType: 'audio/mpeg',
        });

        state.currentIndex += 1;
        const remaining = state.queue.length - state.currentIndex;
        await bot.sendMessage(chatId, t(chatId).fileDone(remaining));
    } catch (error) {
        console.error(error);
        state.currentIndex += 1;
        await bot.sendMessage(chatId, t(chatId).error);
    }

    // Move on to next file in queue (or finish)
    await startTaggingNext(chatId);
}

// ---------------------------------------------------------------------------
// /start and language selection
// ---------------------------------------------------------------------------
bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    resetState(chatId);
    await bot.sendMessage(chatId, TEXT.en.chooseLang, languageInlineKeyboard());
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'lang_ru' || data === 'lang_en') {
        userLang[chatId] = data === 'lang_ru' ? 'ru' : 'en';
        resetState(chatId);
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, t(chatId).welcome(0), mainKeyboard(chatId));
    }
});

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text && !msg.audio && !msg.photo) return;
    if (msg.text === '/start') return; // handled by onText above

    // Require a language before anything else
    if (!userLang[chatId]) {
        return bot.sendMessage(chatId, TEXT.en.chooseLang, languageInlineKeyboard());
    }

    const labels = btn(chatId);

    // ---- Cancel button (works at any stage) ----
    if (msg.text === labels.cancel) {
        if (userStates[chatId]) {
            resetState(chatId);
            await bot.sendMessage(chatId, t(chatId).cancelled, mainKeyboard(chatId));
        } else {
            await bot.sendMessage(chatId, t(chatId).nothingToCancel, mainKeyboard(chatId));
        }
        return;
    }

    // ---- "Send Audio" button: just a hint, does nothing else ----
    if (msg.text === labels.sendAudio) {
        const state = getQueueState(chatId);
        await bot.sendMessage(chatId, t(chatId).welcome(state.queue.length), mainKeyboard(chatId));
        return;
    }

    // ---- "Done - Start Tagging" button ----
    if (msg.text === labels.done) {
        const state = getQueueState(chatId);
        if (state.queue.length === 0) {
            await bot.sendMessage(chatId, t(chatId).queueEmpty, mainKeyboard(chatId));
            return;
        }
        state.currentIndex = 0;
        await startTaggingNext(chatId);
        return;
    }

    // ---- Receiving audio: add to queue ----
    if (msg.audio) {
        const state = getQueueState(chatId);
        const fileName = msg.audio.title
            ? `${msg.audio.performer ? msg.audio.performer + ' - ' : ''}${msg.audio.title}`
            : (msg.audio.file_name || 'Untitled');
        state.queue.push({ audioId: msg.audio.file_id, fileName });
        await bot.sendMessage(chatId, t(chatId).audioReceived(state.queue.length), mainKeyboard(chatId));
        return;
    }

    const state = userStates[chatId];

    // ---- Cover stage ----
    if (state && state.stage === 'cover') {
        if (msg.photo) {
            state.coverId = msg.photo[msg.photo.length - 1].file_id;
            const current = state.queue[state.currentIndex];
            state.stage = 'tagging';
            await bot.sendMessage(chatId, t(chatId).coverSaved(current.fileName), taggingKeyboard(chatId));
            return;
        }
        if (msg.text === labels.skip) {
            const current = state.queue[state.currentIndex];
            state.stage = 'tagging';
            await bot.sendMessage(chatId, t(chatId).coverSkipped(current.fileName), taggingKeyboard(chatId));
            return;
        }
        return; // ignore anything else while waiting for cover/skip
    }

    // ---- Tagging stage: expects "Title - Artist" ----
    if (state && state.stage === 'tagging' && msg.text) {
        const parts = msg.text.split('-');
        if (parts.length < 2) {
            await bot.sendMessage(chatId, t(chatId).badFormat, taggingKeyboard(chatId));
            return;
        }
        const title = parts[0].trim();
        const artist = parts.slice(1).join('-').trim();
        await processCurrentFile(chatId, title, artist);
        return;
    }

    // ---- Fallback: no active flow ----
    if (!state) {
        const s = getQueueState(chatId);
        await bot.sendMessage(chatId, t(chatId).welcome(s.queue.length), mainKeyboard(chatId));
    }
});

console.log('Bot is running...');