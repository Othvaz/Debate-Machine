import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

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
            "X-Title": "NewsDebateWeb",
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

async function summarizeLink(link){
    return "";
}

async function modelOpenings(summary, MODEL_A, MODEL_B, perspective){
    
    const sysA = `You argue FOR the central claim. Your opposition will argue AGAINST the central claim. You will use ONLY the SUMMARY facts. Respond through lens of ${perspective}. 220-280 words. No insults.`;
    const sysB = `You argue AGAINST the central claim. Your opposition will argue FOR the central claim. You will use ONLY the SUMMARY facts. Respond through lens of ${perspective}. 220-280 words. No insults.`;

    const rawA = await chat(MODEL_A,sysA,`SUMMARY:\n${summary}\n\nWrite your opening.`,0.4);
    const rawB = await chat(MODEL_B,sysB,`SUMMARY:\n${summary}\n\nWrite your opening.`,0.4);
    
    return { aOpeningClipped: cliptoLastSentence(rawA), bOpeningClipped: cliptoLastSentence(rawB)};
}

async function modelRebuttals(summary,oppositionA, oppositionB, MODEL_A, MODEL_B, perspective){
    
    const sysA = `You argue FOR the central claim. Respond directly to the opponent's opening using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line.`;
    const sysB = `You argue AGAINST the central claim. Respond directly to the opponent's opening using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line.`;

    const rawA = await chat(MODEL_A,sysA,`SUMMARY:\n${summary}\n\nOPPOSITION'S OPENING (AGAINST):\n${oppositionB}\n\nWrite your rebuttal.`);
    const rawB = await chat(MODEL_B,sysB,`SUMMARY:\n${summary}\n\nOPPOSITION'S OPENING (FOR):\n${oppositionA}\n\nWrite your rebuttal.`);
    
    return { aRebuttalClipped: cliptoLastSentence(rawA), bRebuttalClipped: cliptoLastSentence(rawB)};
}

async function modelFollowup(summary,oppositionOpeningA,oppositionRebuttalA,oppositionOpeningB,oppositionRebuttalB, MODEL_A, MODEL_B, perspective){
    
    const sysA = `You argue FOR the central claim. Respond directly to the opponent's opening and their rebuttal using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line.`;
    const sysB = `You argue AGAINST the central claim. Respond directly to the opponent's opening and their rebuttal using only the SUMMARY and facts. Respond through lens of ${perspective}. 160-220 words. No insults. All in one line.`;

    const rawA = await chat(MODEL_A,sysA,`SUMMARY:\n${summary}\n\nYOUR OPENING STATEMENT (FOR):\n${oppositionOpeningA}\n\nOPPOSITION'S OPENING (AGAINST):\n${oppositionOpeningB}\n\nOPPOSITION'S REBUTTAL TO YOUR OPENING:\n${oppositionRebuttalB}\n\nWrite your followup regarding all this.`);
    const rawB = await chat(MODEL_B,sysB,`SUMMARY:\n${summary}\n\nYOUR OPENING STATEMENT (AGAINST):\n${oppositionOpeningB}\n\nOPPOSITION'S OPENING (FOR):\n${oppositionOpeningA}\n\nOPPOSITION'S REBUTTAL TO YOUR OPENING:\n${oppositionRebuttalA}\n\nWrite your followup regarding all this.`);

    return { aFollowupClipped: cliptoLastSentence(rawA), bFollowupClipped: cliptoLastSentence(rawB)};

}
app.post("/api/summarize", async(req,res) =>{
    try{
        let userText;
        if (req.body && req.body.text){
            userText = String(req.body.text);
        }
        else{
            userText = ""
        }
        if (!userText){return res.status(400).json({error:"Missing 'text' in body."});}

        const summary = await summarizeText(userText);
        res.json({summary});
    }
    catch(e){
        res.status(500).json({error: String(e)});
    }
});

app.post("/api/run", async (req,res) => {
    try{
        let userText;
        let userSummary;
        if (req.body && req.body.summary){
            userSummary = String(req.body.summary);
        }
        else{
            userText = ""
        }
        if (userText === ""){return res.status(400).json({error:"Missing 'text' in body."});}

        const modelA = req.body?.modelA || process.env.MODEL_A || "deepseek/deepseek-r1-0528";
        const modelB = req.body?.modelB || process.env.MODEL_B || "deepseek/deepseek-r1-0528";
        console.log("Using models:", modelA, modelB);

        const perspectiveSelected = req.body?.perspectives || "Morality";
        
        const {aOpeningClipped, bOpeningClipped} = await modelOpenings(userSummary, modelA, modelB, perspectiveSelected);
        const {aRebuttalClipped, bRebuttalClipped} = await modelRebuttals(userSummary,aOpeningClipped, bOpeningClipped, modelA, modelB, perspectiveSelected);
        const {aFollowupClipped, bFollowupClipped} = await modelFollowup(userSummary,aOpeningClipped,aRebuttalClipped,bOpeningClipped,bRebuttalClipped, modelA, modelB, perspectiveSelected);

        res.json({aOpeningClipped,bOpeningClipped,aRebuttalClipped,bRebuttalClipped,aFollowupClipped,bFollowupClipped});
    }
    catch (e){
        res.status(500).json({error: String(e)});
    }
});

app.listen(3000, () => {
    console.log("Server listening on http://localhost:3000.. or something?");   
});