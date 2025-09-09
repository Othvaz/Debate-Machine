import express, { json } from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";

const { Pool } = pkg;

dotenv.config({ override: true });
const pool = new Pool({connectionString: process.env.DATABASE_URL});

const app = express();
app.use(cors());
app.use(express.json({limit: "1mb"}));
app.use(express.static("public"));
app.get("/health", (_req,res) => res.json({ok:true}));

const OPENROUTER_BASE = process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
// const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

async function chat(model, systemText, userText, temperature = 0.2, jsonMode = false, maxTokens = undefined){
    const messages = [];
    if (systemText && systemText.trim() !== ""){
        messages.push({role:"system",content:systemText})
    }
    messages.push({role:"user", content:userText});

    const body = {
        model:model,
        messages: messages,
        temperature: temperature,
        stream: false
    };
    if (jsonMode){
        body.response_format = { type: "json_object" };
    }
    if (maxTokens){
        body.max_tokens = maxTokens;
    }

    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost",
            "X-Title": "NewsDebateWeb"
        },
        body: JSON.stringify(body)
    });
    if (!response.ok){
        const errorText = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}


//let's figure this out together.
function buildDaBody(model, messages, stream, webEnabled){
    const body = { model, messages, stream }
    if (webEnabled){
        const plugin = { id: "web" };
        const searchPrompt = "Summarize the content of the web result given to you.";
        const maxResults = 1;
        plugin.search_prompt = searchPrompt;
        plugin.max_results = maxResults;
        body.plugins = [plugin];
    }
    return body;
}

async function chatStreamWithOpenAI(systemText, userText, contentType, res) {
    if (!res.headersSent){
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders?.();
    }
    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const stream = await openai.responses.create({
            model: "gpt-4.1-mini",
            instructions: systemText,
            tools: [
                { type: "web_search" },
            ],
            input: `${systemText} Here is the article link: ${userText}`,
            stream: true,
        });

        let fullText = "";
        for await (const chunk of stream) {
            if (chunk.type === "response.output_text.delta"){
                let filtered = chunk.delta;
                filtered = filtered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
                filtered = filtered.replace(/https?:\/\/\S+/g, "");
                filtered = filtered.replace(/\b(?:www\.)?[A-Za-z0-9\-_]+\.[A-Za-z]{2,}(?:\/\S*)?\b/g, "");
                filtered = filtered.replace(/^\s*Sources?:.*$/gim, "");
                filtered = filtered.replace(/\s*[\(\[]\s*[\)\]]\s*/g, "");
                filtered = filtered.replace(/(\S)-/g, "$1\n-");
                fullText += filtered;
                res.write(JSON.stringify({ contentType, text: filtered }) + "\n");
            }
        }
        res.write(JSON.stringify({ contentType, done: true }) + "\n");
        return fullText;

    } catch (err) {
        console.error("OpenAI API Error:", err.message);
        const errorPayload = { type: "error", text: `OpenAI API error: ${err.message}`};
        
        if (!res.headersSent) {
            res.status(500).json(errorPayload);
        } else {
            res.write(JSON.stringify(errorPayload) + "\n");
            res.end();
        }
        return null;
    }
}

//we're trying to receive from openrouter, specify that we want it to be stream data, not normal
async function chatStream(model, systemText, userText, contentType, res){
    //what does chatstream take in? what do we need chatstream for? it will be the method where every request is forwarded to OR and the response is taken and redistributed into a newer stream.

    if (!res.headersSent){
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders?.();
    }

    let messages = [];
    if (systemText){
        messages.push({role: "system", content: systemText});
    }
    messages.push({role: "user", content:userText});
    
    const body = buildDaBody(model, messages, true);

    //okay, we've set what we want our respose to the server will look like. now to call from openrouter
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": 'application/json',
            "HTTP-Referer": 'http://localhost',
            "X-Title": 'NewsDebateWeb,'
        },
        // body: JSON.stringify({
        //     model: model,
        //     messages: messages,
        //     stream: true
        // }),
        body: JSON.stringify(body),
    });

    if (!response.ok){
        const errorText = await response.text();
        console.log(`Error at getting a response: ${response.status} - ${errorText}`);
        res.write(JSON.stringify({
            type: "error",
            text: `OpenRouter API error: ${response.status} - ${errorText}`
        }) + "\n");
        res.end();
        return;
    }

    let buffer = '';
    const decoder = new TextDecoder();
    const reader = response?.body.getReader();
    if(!reader){
        res.write(JSON.stringify({
            type: "error",
            text: "um, reader is outputting an error. find the issue."
        }) + "\n");
        res.end();
        return;
    }

    let full = '';

    while (true){
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        
        while (true){
            let lineEnd = buffer.indexOf('\n');
            if (lineEnd === -1) break;


            let line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd+1);

            if (line.startsWith('data: ')){
                const data = line.slice(6)
                if (data === "[DONE]") {
                    res.write(JSON.stringify({type:"segment_done"}, contentType) + "\n");
                    return full.trim();
                }
                try{
                    const parsed = JSON.parse(data);
                    const content = parsed.choices[0].delta.content;
                    if(content){
                        full += content;
                        res.write(JSON.stringify({
                            type: "token",
                            contentType,
                            text: content
                        }) + "\n");
                    }
                }
                catch(e){
                    console.log("erro at trying to get dodo");
                    res.write(JSON.stringify({
                        type: "error",
                        text: `error trying to get dodo, with message ${e}`
                    }) + "\n");
                }
            }
        }
    }
}



function cliptoLastSentence(text){
    const t = text.trim();
    let lastIndex = -1;
    for (const mark of [".", "!", "?"]){
        const i = t.lastIndexOf(mark);
        if (i > lastIndex){
            lastIndex = i;
        }
    }
    if (lastIndex === -1){
        return t;
    }
    const cutText = t.slice(0, lastIndex + 1);
    return cutText.trim();
}

async function summarizeText(text){
    const MODEL = process.env.SUMMARY_MODEL;
    const SYS =  "Summarize the article in 8-12 bullet points. Be neutral, factual. Include concrete dates, numbers, names. No opinion of your own. Only respond with the summary and nothing more. Do not include any openings such as 'Here is a summary of...'. Get straight to the point.";
    const raw = await chat(MODEL,SYS,text,0.2,false,2000);
    return cliptoLastSentence(raw);
}

// async function summarizeLink(link){
//     const MODEL = process.env.SUMMARY_MODEL;
//     const SYS =  "Summarize the article in 8-12 bullet points. Be neutral, factual. Include concrete dates, numbers, names. No opinion of your own. Only respond with the summary and nothing more. Do not include any openings such as 'Here is a summary of...'. Get straight to the point.";
//     const raw = await chat(MODEL,SYS,text,0.2,false,2000);
//     return raw;
// }

app.get("/api/getsummaries", async(req, res)=>{
    const client = await pool.connect();
    try{
        const theQuery = `SELECT
        o.summaryoutputtext,
        i.summaryinputtext,
        i.summaryinputid
        FROM summaryoutput o
        JOIN summaryinput i ON i.summaryinputid = o.summaryinputid
        ORDER BY o.summaryoutputid ASC
        `
        const result = await client.query(theQuery);
        res.json(result.rows);
    }
    catch(err){
        console.log(err.message);
    }
    finally{
        client?.release();
    }
})

app.get("/api/getdebates", async (req, res) =>{
    const client = await pool.connect();
    try{
        const theQuery = `SELECT 
        o.debateoutputtextopeningfor,
        o.debateoutputtextopeningagainst,
        o.debateoutputtextrebuttalfor,
        o.debateoutputtextrebuttalagainst,
        o.debateoutputtextfollowupfor,
        o.debateoutputtextfollowupagainst,
        d.debateinputtext,
        d.modela,
        d.modelb,
        d.perspectives,
        d.debateinputid
        FROM debateoutput o
        JOIN debateinput d ON d.debateinputid = o.debateinputid
        ORDER BY o.debateoutputid ASC`;

        const result = await client.query(theQuery);
        res.json(result.rows);
    
    }
    catch(err){
        alert(err.message);
    }
    finally{
        client?.release();
    }
})
app.post("/api/summarize/stream", async (req, res) => {
    const online = Boolean(req?.body?.online);
    const MODEL = online?`${process.env.SUMMARY_MODEL}:online` : process.env.SUMMARY_MODEL;
    let SYS =  "Summarize the article in 8-12 bullet points. Be neutral, factual. Include concrete dates, numbers, names. No opinion of your own. Only respond with the summary and nothing more. Do not include any openings such as 'Here is a summary of...'. Get straight to the point.";
    const USTXT = req?.body?.text;
    const contentType = "summary";
    try{
        let summarizeStream;
        if(online){
            console.log("We're gonna use OpenAI!");
            SYS += "In your response, DO NOT provide links at the end of each point. Format should be: - [Article Summary] [Newline] - [Article Sumamry]].";
            summarizeStream = await chatStreamWithOpenAI(SYS, USTXT, contentType, res);

        }
        else{
            console.log("We're gonna use OpenRouter!");
            summarizeStream = await chatStream(MODEL, SYS, USTXT, contentType, res);
        }
        let client;
        try{
            client = await pool.connect();
            await client.query("BEGIN");

            const r1 = await client.query(
                `INSERT INTO summaryInput (summaryInputText)
                 VALUES ($1)
                 RETURNING summaryinputid AS id`,
                [USTXT]
            );
            const inputId = r1.rows[0].id;

            const r2= await client.query(
                `INSERT INTO summaryOutput (summaryInputId, summaryOutputText)
                 VALUES ($1, $2)
                 RETURNING summaryoutputid AS id`,
                [inputId, summarizeStream]
            );
            await client.query("COMMIT");
            console.log('Inserted: ', {inputId, outputId:r2.rows[0].id});

        }
        catch(err){
            if (client) await client.query("ROLLBACK").catch(() => {});
            res.write(JSON.stringify({ type: "error", text: `Error: ${err.message}` }) + "\n");
        }
        finally{
            if (client) client.release();
        }
        res.write(JSON.stringify({ done: true }) + "\n");
        res.end();
    }
    catch(err){
        if (!res.headersSent) {
            return res.status(500).json({ error: String(err) });
        }
        res.write(JSON.stringify({ type: "error", text: String(err) }) + "\n");
        res.end();
    }

});

app.post("/api/run/stream", async (req, res) => {
    try{
        const summary = req?.body?.summary;
        const modelA = req?.body?.modelA;
        const modelB = req?.body?.modelB;

        // canonical stuff and uhhh stuff
        const normalizeModel = (m) => String(m || '').replace(/:online$/, '').trim();
        const modelANorm = normalizeModel(modelA);
        const modelBNorm = normalizeModel(modelB);


        const perspectiveSelected = req?.body?.perspectives || "Morality";
        const processedPerspective = Array.from(
        new Set(String(perspectiveSelected).split(',').map(s => s.trim()).filter(Boolean))
        ).sort((a,b) => a.localeCompare(b));
        
        const perspectiveKey = processedPerspective.join(','); // canonical string

    
        if (!summary){
            return res.status(400).json({error: "missing 'summary'!! WHY??!"});
        }
        if (!modelA || !modelB){
            return res.status(400).json({error: "missing 'modelA or modelB'!! WHY??!"});
        }

        const theQuery = `
        SELECT
        o.debateOutputTextOpeningFor  AS "aOpeningClipped",
        o.debateOutputTextOpeningAgainst AS "bOpeningClipped",
        o.debateOutputTextRebuttalFor AS "aRebuttalClipped",
        o.debateOutputTextRebuttalAgainst AS "bRebuttalClipped",
        o.debateOutputTextFollowupFor AS "aFollowupClipped",
        o.debateOutputTextFollowupAgainst AS "bFollowupClipped"
        FROM debateInput d
        JOIN debateOutput o ON o.debateInputId = d.debateInputId
        WHERE d.debateInputText = $1
        AND d.modelA = $2
        AND d.modelB = $3
        AND d.perspectives = $4
        LIMIT 1
        `;
        const cached = await pool.query(theQuery, [summary, modelANorm, modelBNorm, processedPerspective]);        
        if (cached.rows.length){
            const r = cached.rows[0];
            if (!res.headersSent){
                res.setHeader("Connection", "keep-alive");
                res.setHeader("Content-Type", "application/x-ndjson");
                res.setHeader("Cache-Control", "no-cache");
                res.flushHeaders?.();
            }
    
            const send = (contType, text) =>
                res.write(JSON.stringify({type:"token", contentType: contType, text}) + "\n");
            send("openingA",  r.aOpeningClipped);
            send("openingB",  r.bOpeningClipped);
            send("rebuttalA", r.aRebuttalClipped);
            send("rebuttalB", r.bRebuttalClipped);
            send("followupA", r.aFollowupClipped);
            send("followupB", r.bFollowupClipped);

            res.write(JSON.stringify({done:true}) + "\n");
            res.end();
            alert("Similar Debate Found!");
            return;
        }

 
        
        
        const openingSystemA = `You argue FOR the central claim. Your opposition will argue AGAINST the central claim. You will use ONLY the SUMMARY facts. Respond through lens of ${perspectiveKey}. 220-280 words. No insults.`;
        const openingSystemB = `You argue AGAINST the central claim. Your opposition will argue FOR the central claim. You will use ONLY the SUMMARY facts. Respond through lens of ${perspectiveKey}. 220-280 words. No insults.`;
    
        const rebuttalSystemA = `You argue FOR the central claim. Respond directly to the opponent's opening using only the SUMMARY and facts. Respond through lens of ${perspectiveKey}. 160-220 words. No insults. All in one line.`;
        const rebuttalSystemB = `You argue AGAINST the central claim. Respond directly to the opponent's opening using only the SUMMARY and facts. Respond through lens of ${perspectiveKey}. 160-220 words. No insults. All in one line.`;
    
        const followupSystemA = `You argue FOR the central claim. Respond directly to the opponent's opening and their rebuttal using only the SUMMARY and facts. Respond through lens of ${perspectiveKey}. 160-220 words. No insults. All in one line.`;
        const followupSystemB = `You argue AGAINST the central claim. Respond directly to the opponent's opening and their rebuttal using only the SUMMARY and facts. Respond through lens of ${perspectiveKey}. 160-220 words. No insults. All in one line.`;
    
        const outputOpeningA = await chatStream(modelA, openingSystemA,`SUMMARY:\n${summary}\n\nWrite your opening.`,"openingA", res);
    
        const outputOpeningB = await chatStream(modelB, openingSystemB,`SUMMARY:\n${summary}\n\nWrite your opening.`,"openingB", res);
        const outputRebuttalA = await chatStream(modelA, rebuttalSystemA, `SUMMARY:\n${summary}\n\nOPPOSITION'S OPENING (AGAINST):\n${outputOpeningB}\n\nWrite your rebuttal.`, "rebuttalA", res);
        const outputRebuttalB = await chatStream(modelB, rebuttalSystemB, `SUMMARY:\n${summary}\n\nOPPOSITION'S OPENING (FOR):\n${outputOpeningA}\n\nWrite your rebuttal.`, "rebuttalB", res);
        const outputFollowupA = await chatStream(modelA, followupSystemA, `SUMMARY:\n${summary}\n\nYOUR OPENING STATEMENT (FOR):\n${outputOpeningA}\n\nOPPOSITION'S OPENING (AGAINST):\n${outputOpeningB}\n\nOPPOSITION'S REBUTTAL TO YOUR OPENING:\n${outputRebuttalB}\n\nWrite your followup regarding all this.`, "followupA", res);
        const outputFollowupB = await chatStream(modelB, followupSystemB, `SUMMARY:\n${summary}\n\nYOUR OPENING STATEMENT (AGAINST):\n${outputOpeningB}\n\nOPPOSITION'S OPENING (FOR):\n${outputOpeningA}\n\nOPPOSITION'S REBUTTAL TO YOUR OPENING:\n${outputRebuttalA}\n\nWrite your followup regarding all this.`, "followupB", res);

        

        let client;
        try {
        client = await pool.connect();
        await client.query('BEGIN');

        const r1 = await client.query(
            `INSERT INTO debateInput (debateInputText, modelA, modelB, perspectives)
            VALUES ($1, $2, $3, $4)
            RETURNING debateinputid AS id`,
            [summary, modelANorm, modelBNorm, processedPerspective]
        );
        const inputId = r1.rows[0].id;

        const r2 = await client.query(
            `INSERT INTO debateOutput (
            debateInputId,
            debateOutputTextOpeningFor,
            debateOutputTextOpeningAgainst,
            debateOutputTextRebuttalFor,
            debateOutputTextRebuttalAgainst,
            debateOutputTextFollowupFor,
            debateOutputTextFollowupAgainst
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING debateoutputid AS id`,
            [
            inputId,
            outputOpeningA,
            outputOpeningB,
            outputRebuttalA,
            outputRebuttalB,
            outputFollowupA,
            outputFollowupB
            ]
        );

        await client.query('COMMIT');
        console.log('Inserted: ', {inputId, outputId:r2.rows[0].id});


        } catch (dbErr) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.log("here, here.")
        res.write(JSON.stringify({ type: "warn", text: `db error: ${dbErr.message}` }) + "\n");
        } finally {
            if (client) client.release();
        }

        res.write(JSON.stringify({
            done: true,
            payload: {
                openingA: outputOpeningA,
                openingB: outputOpeningB,
                rebuttalA: outputRebuttalA,
                rebuttalB: outputRebuttalB,
                followupA: outputFollowupA,
                followupB: outputFollowupB
            }
        }) + "\n");

        res.end();
    }
    catch(err){
        if (res.headersSent){
            console.log("here, here(2)")
            res.write(JSON.stringify({ error: String(err) }) + "\n");
            res.end();
        }
        else {
            console.log(`here, here(4) ERROR IS ${err.message}`);
            res.status(500).json({ error: String(err) });
        }
    }
});

async function modelOpenings(summary, MODEL_A, MODEL_B, perspective){
    
    const sysA = `You argue FOR the central claim. Your opposition will argue AGAINST the central claim. You will use ONLY the SUMMARY facts. Respond through lens of ${perspective}. 220-280 words. No insults. Respond with the same language as the summary.`;
    const sysB = `You argue AGAINST the central claim. Your opposition will argue FOR the central claim. You will use ONLY the SUMMARY facts. Respond through lens of ${perspective}. 220-280 words. No insults. Respond with the same language as the summary.`;

    const rawA = await chat(MODEL_A,sysA,`SUMMARY:\n${summary}\n\nWrite your opening.`,0.4);
    const rawB = await chat(MODEL_B,sysB,`SUMMARY:\n${summary}\n\nWrite your opening.`,0.4);
    
    return { aOpeningClipped: cliptoLastSentence(rawA), bOpeningClipped: cliptoLastSentence(rawB)};
}

async function modelRebuttals(summary,oppositionA, oppositionB, MODEL_A, MODEL_B, perspective){
    
    const sysA = `You argue FOR the central claim. Respond directly to the opponent's opening using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line. Respond with the same language as the summary.`;
    const sysB = `You argue AGAINST the central claim. Respond directly to the opponent's opening using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line. Respond with the same language as the summary.`;

    const rawA = await chat(MODEL_A,sysA,`SUMMARY:\n${summary}\n\nOPPOSITION'S OPENING (AGAINST):\n${oppositionB}\n\nWrite your rebuttal.`);
    const rawB = await chat(MODEL_B,sysB,`SUMMARY:\n${summary}\n\nOPPOSITION'S OPENING (FOR):\n${oppositionA}\n\nWrite your rebuttal.`);
    
    return { aRebuttalClipped: cliptoLastSentence(rawA), bRebuttalClipped: cliptoLastSentence(rawB)};
}

async function modelFollowup(summary,oppositionOpeningA,oppositionRebuttalA,oppositionOpeningB,oppositionRebuttalB, MODEL_A, MODEL_B, perspective){
    
    const sysA = `You argue FOR the central claim. Respond directly to the opponent's opening and their rebuttal using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line. Respond with the same language as the summary.`;
    const sysB = `You argue AGAINST the central claim. Respond directly to the opponent's opening and their rebuttal using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line. Respond with the same language as the summary.`;

    const rawA = await chat(MODEL_A,sysA,`SUMMARY:\n${summary}\n\nYOUR OPENING STATEMENT (FOR):\n${oppositionOpeningA}\n\nOPPOSITION'S OPENING (AGAINST):\n${oppositionOpeningB}\n\nOPPOSITION'S REBUTTAL TO YOUR OPENING:\n${oppositionRebuttalB}\n\nWrite your followup regarding all this.`);
    const rawB = await chat(MODEL_B,sysB,`SUMMARY:\n${summary}\n\nYOUR OPENING STATEMENT (AGAINST):\n${oppositionOpeningB}\n\nOPPOSITION'S OPENING (FOR):\n${oppositionOpeningA}\n\nOPPOSITION'S REBUTTAL TO YOUR OPENING:\n${oppositionRebuttalA}\n\nWrite your followup regarding all this.`);

    return { aFollowupClipped: cliptoLastSentence(rawA), bFollowupClipped: cliptoLastSentence(rawB)};

}

app.post("/api/summarize", async(req,res) =>{
    let userText;
    try{
        if (req.body && req.body.text){
            userText = String(req.body.text);
        }
        else{
            userText = ""
        }
        if (userText == ""){return res.status(400).json({error:"Missing 'text' in body."});}

        const summary = await summarizeText(userText);
        let client;

        try{
            client = await pool.connect();
            await client.query('BEGIN');

            const r1 = await client.query(`
                INSERT INTO summaryInput(summaryInputText) VALUES ($1) RETURNING summaryinputid as id
                `, [userText]);
            const inputId = r1.rows[0].id;

            const r2 = await client.query(`
                INSERT INTO summaryOutput (summaryInputId, summaryOutputText) VALUES ($1, $2) RETURNING summaryoutputid as id
                `, [inputId, summary]);

            await client.query('COMMIT');
            console.log('Inserted: ', {inputId, outputId:r2.rows[0].id});
        }
        catch (dbErr){
            if (client) await client.query('ROLLBACK').catch(()=>{});
            console.log("Got an error:", {dbErr})
        }
        finally{
            if (client) client.release();
        }
        res.json({summary});
    }
    catch(e){
        res.status(500).json({error: String(e)});
    }
});

app.post("/api/buttonforTesting", async(req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    if (req?.body?.text == "dodoTest"){
        console.log("dodoTest received.")
        res.write(JSON.stringify({type:"dodo", content: "dodobird"}));
        res.end();
    }
    else{   
        console.log("dodoTest NOT received.")
    }

    
});

app.post("/api/run", async (req,res) => {
    try{
        let userSummary;
        if (req.body && req.body.summary){
            userSummary = String(req.body.summary);
        }
        else{
            userSummary = ""
        }
        if (userSummary === ""){return res.status(400).json({error:"Missing 'text' in body."});}
        

        const modelA = req.body?.modelA || process.env.MODEL_A || "deepseek/deepseek-r1-0528";
        const modelB = req.body?.modelB || process.env.MODEL_B || "deepseek/deepseek-r1-0528";
        console.log("Using models:", modelA, modelB);

        const perspectiveSelected = req.body?.perspectives || "Morality";
        let rawPerspective = perspectiveSelected;
        let processedPerspective = rawPerspective
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

        processedPerspective = Array.from(new Set(processedPerspective)).sort((a,b)=> a.localeCompare(b));

        const theQuery = `
        SELECT
        o.debateOutputTextOpeningFor  AS "aOpeningClipped",
        o.debateOutputTextOpeningAgainst AS "bOpeningClipped",
        o.debateOutputTextRebuttalFor AS "aRebuttalClipped",
        o.debateOutputTextRebuttalAgainst AS "bRebuttalClipped",
        o.debateOutputTextFollowupFor AS "aFollowupClipped",
        o.debateOutputTextFollowupAgainst AS "bFollowupClipped"
        FROM debateInput d
        JOIN debateOutput o ON o.debateInputId = d.debateInputId
        WHERE d.debateInputText = $1
        AND d.modelA = $2
        AND d.modelB = $3
        AND d.perspectives = $4
        LIMIT 1
        `;
        const cached = await pool.query(theQuery, [userSummary, modelA, modelB, processedPerspective]);
        if (cached.rows.length){
            const r = cached.rows[0];
            return res.json({
                aOpeningClipped: r.aOpeningClipped,
                bOpeningClipped: r.bOpeningClipped,
                aRebuttalClipped: r.aRebuttalClipped,
                bRebuttalClipped: r.bRebuttalClipped,
                aFollowupClipped: r.aFollowupClipped,
                bFollowupClipped: r.bFollowupClipped,
                cached: true
                });
        }

        const {aOpeningClipped, bOpeningClipped} = await modelOpenings(userSummary, modelA, modelB, perspectiveSelected);
        const {aRebuttalClipped, bRebuttalClipped} = await modelRebuttals(userSummary,aOpeningClipped, bOpeningClipped, modelA, modelB, perspectiveSelected);
        const {aFollowupClipped, bFollowupClipped} = await modelFollowup(userSummary,aOpeningClipped,aRebuttalClipped,bOpeningClipped,bRebuttalClipped, modelA, modelB, perspectiveSelected);
        
        let client;
        try{
            client = await pool.connect();
            await client.query('BEGIN');

            const r1 = await client.query(`
                INSERT INTO debateInput(debateInputText, modelA, modelB, perspectives) VALUES ($1, $2, $3, $4) RETURNING debateinputid AS id
                `, [userSummary, modelA, modelB, processedPerspective]);
            
            const inputId = r1.rows[0].id;

            const r2 = await client.query(`
                INSERT INTO debateOutput(debateInputId, debateOutputTextOpeningFor, debateOutputTextOpeningAgainst, debateOutputTextRebuttalFor, debateOutputTextRebuttalAgainst, debateOutputTextFollowupFor, debateOutputTextFollowupAgainst) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING debateOutputId AS id
                `, [inputId, aOpeningClipped,bOpeningClipped,aRebuttalClipped,bRebuttalClipped,aFollowupClipped,bFollowupClipped]);
            
            await client.query('COMMIT');
            console.log("Inserted: ", {inputId, outputId:r2.rows[0].id});
        }
        catch (dbErr){
            if (client) await client.query('ROLLBACK').catch(()=>{});
            console.log("Got an error:", {dbErr});

        }

        finally{
            if (client) client.release();
        }
        res.json({aOpeningClipped,bOpeningClipped,aRebuttalClipped,bRebuttalClipped,aFollowupClipped,bFollowupClipped});
    }
    catch (e){
        res.status(500).json({error: String(e)});
    }
});

app.listen(3000, () => {
    console.log("Server listening on http://localhost:3000.. or something?");   
});
