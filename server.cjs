require("dotenv").config();
const axios = require("axios");
const PptxGenJS = require("pptxgenjs");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const assistantsPath = path.join(__dirname, "./data/assistants.json");
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
  const { prompt, threadId, assistantName, uid } = req.body;
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
        messages: JSON.stringify(formattedMessages),
        usage: JSON.stringify({
          ...(currentChat?.usage || {}),
          [run.id]: run.usage,
        }),
        title: titleCompletion?.choices?.[0]?.message?.content,
        assistant_name: chooseAssistant,
        user_id: uid,
        ...(!currentChat ? { created_at: new Date() } : {}),
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
      model: "gpt-4o",
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

const createCourseCurriulum = async (req, res) => {
  const {
    lengthOfClassTotal,
    lengthOfClassPerSession,
    sessionsPerWeek,
    gradeOrAge,
    numberOfStudents,
    certificatesOrStandards,
    equipmentQuestions,
  } = req.body;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const folder = "tmp/" + Math.random().toString(36).substring(2, 10);

  // Create the folder if it doesn't exist
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    console.log("Folder created:", folder);
  } else {
    console.log("Folder already exists:", folder);
  }

  const curriculumPrompt = `
    You are assisting a teacher who is teaching students to pass the ${certificatesOrStandards} over ${lengthOfClassTotal}. 
    Students are in ${gradeOrAge} and the class meets ${sessionsPerWeek} times per week, with each session lasting for ${lengthOfClassPerSession}. 
    The class has ${numberOfStudents} students. 
    Please create a curriculum for this class, taking into account the proper prerequisites for each subject, and keeping it feasible for the students based on their grade or age. 
    ${equipmentQuestions.map((q) => q).join("\n")}

    Start by listing the the blocks of 3 weeks each with a title and a brief description of what will be covered in that time. Then create a detailed curriculum for the ${lengthOfClassTotal} curriculum in markdown format.
    Respond in this JSON format:
    {
      blocks: [
        {
          title: "Week 1",
          description: "This week we will cover...",
        },
        {
          title: "Week 2",
          description: "This week we will cover...",
        }, etc.
      ]
      fullCurriculum: "Your full curriculum in markdown format here."
    }
  `;

  try {
    console.log("Generating curriculum...");
    const curriculumResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: curriculumPrompt }],
      response_format: { type: "json_object" },
      // max_tokens: 1500,
    });

    const curriculum = JSON.parse(
      curriculumResponse.choices[0].message.content
    );
    console.log("Curriculum generated:", curriculum);
    const curriculumFilePath = path.join(__dirname, folder, "curriculum.md");

    fs.writeFile(curriculumFilePath, curriculum.fullCurriculum, (err) => {
      if (err) {
        console.error("Error saving data to file:", err);
      } else {
        console.log("Data successfully saved to", curriculumFilePath);
      }
    });

    const lessonPlanPrompt = `
Continuing from your prior response, can you please create a detailed lesson plan for what the first 3 weeks of Year 1 would be, so that the teacher can instantly start using it? Please take a minute and think it through. 
Be extremely detailed and provide a clear structure for each day. Each day should consist of a title, description, and have information enough to fill a day's worth of powerpoint slides. For each slide, provide a title and the actual content that should be on the slide. Include definitions, examples, and exercises so that the slides are immediately usable without further preparation.
Respond in markdown format.
`;

    console.log("Generating lesson plan...");
    const lessonPlanResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: curriculumPrompt },
        { role: "assistant", content: JSON.stringify(curriculum) },
        { role: "user", content: lessonPlanPrompt },
      ],
    });

    const lessonPlan = lessonPlanResponse.choices[0].message.content;
    console.log("Lesson plan generated:", lessonPlan);
    const lessonPlanFilePath = path.join(__dirname, folder, "lessonPlan.md");

    fs.writeFile(lessonPlanFilePath, lessonPlan, (err) => {
      if (err) {
        console.error("Error saving data to file:", err);
      } else {
        console.log("Data successfully saved to", lessonPlanFilePath);
      }
    });

    const slideCreationPrompt = `
Continuing from your prior response, can you please create slide content for the first week so that the teacher can instantly start using it? Please take a minute and think it through.
Be extremely detailed and provide a clear structure for each day.
Start each day with a teacher's notes slide, explaining the desired outcome for the day and what will be covered. Then include a title page with a description for the students. 
Then, each slide after should consist of a title, image idea(s) and the content for the actual slide explaining the material or prompting the students with questions. Include definitions, examples, and exercises so that the slides are immediately usable without further preparation.

Here is an example of the level of detail expected:
Title: States Rights in the Civil War
Content: 
- The South believed if laws passed by the national or federal government were unfair they wouldn’t have to follow federal laws.
  - Remember the Nullification Crisis during Andrew Jackson’s presidency in 1832? Almost from the start of the U.S. the south has had a different view point on how they should be governed. 
  - This is why the South names their country the Confederate States of America.
    - Federal = Strong National Gov’t
    - Confederate = Weak National Gov’t (States over Nation)
Imagery: Scales weighing the balance between states and federal government.

Respond in markdown format.
`;

    console.log("Generating lesson plan...");
    const slidesResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: curriculumPrompt },
        { role: "assistant", content: JSON.stringify(curriculum) },
        { role: "user", content: lessonPlanPrompt },
        { role: "assistant", content: lessonPlan },
        { role: "user", content: slideCreationPrompt },
      ],
    });

    const slidesPlan = slidesResponse.choices[0].message.content;
    console.log("slides plan generated:", slidesPlan);
    const slidesPlanFilePath = path.join(__dirname, folder, "slidesPlan.md");

    fs.writeFile(slidesPlanFilePath, slidesPlan, (err) => {
      if (err) {
        console.error("Error saving data to file:", err);
      } else {
        console.log("Data successfully saved to", slidesPlanFilePath);
      }
    });
    await generateContentAndPPT({
      content: slidesPlan,
      fileLocation: path.join(__dirname, folder, "slides.pptx"),
    });
    console.log("Content and PowerPoint presentation generated");
    return res.json({ curriculum, lessonPlan });
    const homeworkPrompt = `
      Continuing from your prior response, can you please create a detailed homework/project plan for what the first 3 weeks of Year 1 would be, so that the teacher can instantly start using it? Please take a minute and think it through. Respond in markdown format.
    `;

    console.log("Generating homework...");
    const homeworkResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: curriculumPrompt },
        { role: "assistant", content: JSON.stringify(curriculum) },
        { role: "user", content: lessonPlanPrompt },
        { role: "assistant", content: lessonPlan },
        { role: "user", content: homeworkPrompt },
      ],
      // max_tokens: 1500,
    });

    const homework = homeworkResponse.choices[0].message.content;
    console.log("Homework generated:", homework);

    const homeworkFilePath = path.join(
      __dirname,
      folder,
      generateRandomFilename() + ".md"
    );

    fs.writeFile(homeworkFilePath, homework, (err) => {
      if (err) {
        console.error("Error saving data to file:", err);
      } else {
        console.log("Data successfully saved to", homeworkFilePath);
      }
    });

    const quizPrompt = `
      In your 3 week lesson plan, you include a quiz at the end of Week 3. Can you please create that quiz in enough detail that the teacher can give directly to the students? Respond in markdown format.
    `;

    console.log("Generating quiz...");
    const quizResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: curriculumPrompt },
        { role: "assistant", content: JSON.stringify(curriculum) },
        { role: "user", content: lessonPlanPrompt },
        { role: "assistant", content: lessonPlan },
        { role: "user", content: homeworkPrompt },
        { role: "assistant", content: homework },
        { role: "user", content: quizPrompt },
      ],
      // max_tokens: 1500,
    });

    const quiz = quizResponse.choices[0].message.content;
    console.log("Quiz generated:", quiz);
    const quizFilePath = path.join(
      __dirname,
      folder,
      generateRandomFilename() + ".md"
    );

    fs.writeFile(quizFilePath, quiz, (err) => {
      if (err) {
        console.error("Error saving data to file:", err);
      } else {
        console.log("Data successfully saved to", quizFilePath);
      }
    });

    const dataToSave = {
      curriculum,
      lessonPlan,
      homework,
      quiz,
    };
    const randomFilePath = path.join(
      __dirname,
      folder,
      generateRandomFilename()
    );

    fs.writeFile(randomFilePath, JSON.stringify(dataToSave, null, 2), (err) => {
      if (err) {
        console.error("Error saving data to file:", err);
      } else {
        console.log("Data successfully saved to", randomFilePath);
      }
    });

    // insertData("curriculums", {
    //   lengthOfClassTotal,
    //   lengthOfClassPerSession,
    //   sessionsPerWeek,
    //   gradeOrAge,
    //   numberOfStudents,
    //   certificatesOrStandards,
    //   equipmentQuestions,
    //   curriculum,
    //   lessonPlan,
    //   homework,
    //   quiz,
    // });

    res.json({ curriculum, lessonPlan, homework, quiz });
  } catch (error) {
    console.error("Error generating curriculum:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// Set your API keys
const UNSPLASH_ACCESS_KEY = "YOUR_UNSPLASH_ACCESS_KEY";

async function generateContentAndPPT({ content, fileLocation }) {
  console.log("Generating content and PowerPoint presentation...");
  // Step 1: Generate formatted content and image ideas using GPT-4
  const formattedContent = await generateFormattedContent(content);

  // Step 2: Fetch images based on the ideas
  const images = []; // await fetchImages(formattedContent.imageIdeas);

  // Step 3: Create a PowerPoint presentation
  const ppt = new PptxGenJS();
  formattedContent.slides.forEach((section, index) => {
    const slide = ppt.addSlide();
    slide.addText(section.title, { x: 0.5, y: 0.5, h: "10%", fontSize: 24 });
    slide.addText(section.content, {
      x: 0.5,
      y: 1,
      h: "75%",
      w: "60%",
      fontSize: 14,
    });

    if (images[index]) {
      slide.addImage({ path: images[index], x: 7, y: 2, w: 2.5, h: 3 });
    } else {
      slide.addImage({
        path: "https://ralfvanveen.com/wp-content/uploads/2021/06/Placeholder-_-Glossary-1200x675.webp",
        x: 7,
        y: 0.5,
        w: 2.5,
        h: 3,
      });
    }
  });

  // Step 4: Save the presentation
  await ppt.writeFile({ fileName: fileLocation });
}

// Function to generate formatted content and image ideas using GPT-4
async function generateFormattedContent(content) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `I am turning the content provided into a powerpoint presentation to use in a class. Take the following content and format it into sections with titles, slide content, and suggest image ideas for each section.\n\n${content}.
If the content does not have enough detail to create a slide, please expand on it to make it more suitable for a presentation.
Respond in the following JSON format:
{slides: [
  {
    "title": "Section Title",
    "content": "Section content goes here.",
    "imageIdea": "Image idea goes here."
  },
  {
    "title": "Section Title",
    "content": "Section content goes here.",
    "imageIdea": "Image idea goes here."
  }, etc.
]}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const gptOutput = JSON.parse(response.choices[0].message.content);

  return gptOutput;
}

// Function to fetch images from Unsplash
async function fetchImages(imageIdeas) {
  const imageUrls = await Promise.all(
    imageIdeas.map(async (idea) => {
      const response = await axios.get(
        "https://api.unsplash.com/photos/random",
        {
          params: { query: idea, orientation: "landscape" },
          headers: {
            Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
          },
        }
      );
      return response.data.urls.regular;
    })
  );

  return imageUrls;
}

module.exports = { chatWithAssistant, createAssistant, createCourseCurriulum };

const generateRandomFilename = () => {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const randomString = Math.random().toString(36).substring(2, 10);
  return `file_${timestamp}_${randomString}`;
};
