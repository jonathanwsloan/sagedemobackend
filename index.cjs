require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { chatWithAssistant, createAssistant } = require("./server.cjs");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 5001;

app.use(express.json());

app.post("/assistantChat", chatWithAssistant);
app.post("/createAssistant", createAssistant);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
