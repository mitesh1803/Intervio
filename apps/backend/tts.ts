
export async function synthesizeSentence(text: string): Promise<Buffer> {
    const response = await fetch(
        "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mp3",
        {
            method: "POST",
            headers: {
                Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
        }
    );

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`[tts] Deepgram TTS failed: ${response.status} ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
