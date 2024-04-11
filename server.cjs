require("dotenv").config();
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const chatsPath = path.join(__dirname, "../data/chats.json");
const assistantsPath = path.join(__dirname, "../data/assistants.json");
const { fetchData, insertData } = require("./db.cjs");

const instructions = {
  basicSocraticPrompt: {
    prompt: `You are a study assistant. Your job is to help me understand study material using the socratic method. You should not provide direct responses immediately, instead guiding me through the process of understanding the material. I am a high school student studying, and I will be asking you questions to help prepare.
You are kind, and you should always use simple, understandable language in your responses. 
  
Respond in 2 short paragraphs of 2 sentences, followed by a follow-up question. Make your explanation as entertaining and easily digestible as possible.
When you are providing an explanation, you should always provide references to where the explanation in the study material is. You have access to comprehensive study materials. Your answers must be aligned with the material in the study materials. If I provide a problem that I'm trying to understand, do not answer the problem, help me understand how to work through it by asking questions to help me build reasoning skills.

You MUST ALWAYS return an annotation within to the study material with a quote.`,
  },
  basicReasoningPrompt: {
    prompt: `Your goal is to help me develop critical thinking and problem solving skills using the socratic method.
I will provide you a question. You will then ask questions to hone my reasoning skills while working towards the correct answer. Always just ask one single question that I can respond to, not multiple.
If I make a mistake or am making a poor reasoning choice, gently guide me in the right direction.
You should never directly answer the question I provide, and never provide long responses.
You are kind, and you should always use simple, understandable language in your responses. I am at a high school level, so tailor your language and response accordingly.

You MUST ALWAYS return an annotation within to the study material with a quote.`,
  },
  middleSchoolReasoning: {
    prompt: `You are a study assistant. Your goal is to help me develop critical thinking and problem solving skills using the socratic method.
I will provide you a question. You will then ask questions to hone my reasoning skills while working towards the correct answer. Always just ask one single question that I can respond to, not multiple.
If I make a mistake or am making a poor reasoning choice, gently guide me in the right direction.
You should never directly answer the question I provide, and never provide long responses.
You are kind, and you should always use simple, understandable language in your responses. I am at a middle school level, so tailor your language and response accordingly.

You MUST ALWAYS return an annotation within to the study material with a quote.`,
  },
  middleSchoolSocratic: {
    prompt: `You are a study assistant for a 5-year-old student. Your job is to help me understand study material using the socratic method. 
You are kind, and you should always use simple, understandable language in your responses. 
  
Respond in 1 short paragraph of 2 sentences, followed by a follow-up question on a new line. 

Your answers must be aligned with the material in the study materials. 
If I provide a problem that I'm trying to understand, do not answer the problem, help me understand how to work through it by asking questions to help me build reasoning skills. 
I am at a 12-year-old level, so use EXTREMELY simple language. Talk to me like I am a child. Use metaphors and examples that a child would understand.

You MUST ALWAYS return an annotation within to the study material with a quote.`,
  },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chatWithAssistant = async (req, res) => {
  const { prompt, threadId, assistantName } = req.body;
  console.log("body", req.body);
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const assistants = JSON.parse(fs.readFileSync(assistantsPath));
  Object.keys(assistants).forEach((k) => {
    Object.keys(instructions).forEach((i) => {
      if (assistants[k].prompt.includes(i)) {
        assistants[k].prompt = assistants[k].prompt.replace(i, instructions[i]);
      }
    });
  });
  try {
    const thread = !!threadId
      ? { id: threadId }
      : await openai.beta.threads.create();
    console.log(thread);
    const chooseAssistant =
      assistantName ??
      (
        await openai.chat.completions.create({
          messages: [
            {
              role: "user",
              content:
                "Help me decide which assistant to use for the following conversation: " +
                prompt +
                "\n Respond with just the exact text of one of the following: " +
                Object.keys(assistants)
                  .map((k) => `${k}`)
                  .join(", "),
            },
          ],
          model: "gpt-3.5-turbo",
        })
      )?.choices[0].message.content;
    console.log("using assistant", chooseAssistant);
    const message = await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: prompt,
    });
    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistants[chooseAssistant].id,
      instructions: assistants[chooseAssistant].prompt,
    });
    let timeTaken = 0;
    while (run.status === "queued" || run.status === "in_progress") {
      await delay(1000);
      console.log((timeTaken += 1000), run.status);
      run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    console.log(run);
    const messages = await openai.beta.threads.messages.list(thread.id);

    const formattedMessages = messages.data.reverse().map((message) => {
      return {
        id: message.id,
        createdAt: message.created_at,
        role: message.role,
        content: message.content,
      };
    });
    console.log(formattedMessages);
    const titleCompletion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "Your job is to convert the following input messages into a 3-4 word theme, summarizing the information I was asking about.",
        },
        {
          role: "user",
          content: `Here are the input messages: ${formattedMessages
            .map((m) =>
              m.role === "user" ? m?.content?.[0]?.text?.value || "" : ""
            )
            .join("\n")}
            Now please provide a 3-4 word theme summarizing the information I was asking about.`,
        },
      ],
      model: "gpt-3.5-turbo",
    });

    try {
      const currentChat = await fetchData("chats", {
        filters: { thread_id: thread.id },
      });
      await insertData("chats", {
        thread_id: thread.id,
        messages: formattedMessages,
        usage: { ...(currentChat?.usage || {}), [run.id]: run.usage },
        title: titleCompletion?.choices?.[0]?.message?.content,
        assistant_name: chooseAssistant,
      });
    } catch (err) {
      console.error("Error writing to chats file:", err);
    }

    res.json({
      messages: formattedMessages,
      threadId: thread.id,
      usage: run.usage,
      runId: run.id,
      assistantId: chooseAssistant,
    });
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

const createAssistant = async (req, res) => {
  const { assistantId, description, files, prompt } = req.body;
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  try {
    const uploadedFiles = files.map((file) => {
      return openai.files.create({
        file: file,
        purpose: "assistants",
      });
    });
    await Promise.all(uploadedFiles);

    const assistant = await openai.assistants.create({
      name: assistantId,
      description: description,
      model: "gpt-4-turbo-preview",
      tools: [{ type: "retrieval" }],
      file_ids: uploadedFiles.map((file) => file.id),
    });
    fs.readFile(assistantsPath, (err, data) => {
      if (err) {
        console.error("Error reading assistants file:", err);
        return;
      }
      const assistants = JSON.parse(data);
      assistants[assistantId] = {
        id: assistant.id,
        description: description,
        prompt,
        files: uploadedFiles,
      };
      fs.writeFile(
        assistantsPath,
        JSON.stringify(assistants, null, 2),
        (err) => {
          if (err) {
            console.error("Error writing to assistants file:", err);
          }
        }
      );
    });
    res.json({ assistant });
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

module.exports = { chatWithAssistant, createAssistant };
