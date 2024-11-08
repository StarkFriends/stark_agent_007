import * as readline from "readline";

import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StateGraph } from "@langchain/langgraph";
import { MemorySaver, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  STARKNET_ACCOUNT_ADDRESS,
  STARKNET_PRIVATE_KEY,
} from "./constants.js";
import { generateAccount, deployAccount, getAccount } from "./util/wallet.js";
import { checkBalanceTool } from "./check_balance.js";
import { getNews } from "./util/news.js";
import { ChatOpenAI } from "@langchain/openai";
import { 
  executeSwap, 
  getQuote, 
  type ExecuteSwapOptions, 
  type Quote,
  ETH_ADDRESS,
  STRK_ADDRESS
} from './swap.js';
import { formatUnits } from "ethers";

// Telegram bot setup start
import { Telegraf } from "telegraf";
import { message } from "./tg_bot/filters.js";
import * as dotenv from "dotenv";

dotenv.config();
const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  console.error("No private key defined for the TG bot");
  process.exit(1); // Exit the program with error code
}
const bot = new Telegraf(botToken);

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}
bot.start((ctx) => {
  return ctx.reply(`Hello ${ctx.update.message.from.first_name}!`);
});

// Telegram bot setup finish
import { readFromStorage, saveToStorage } from './util/storage.js';

// Interval ID for background tasks
// Notice: this is just POC, should not be used in prod
let backgroundActionIntervals: Record<string, NodeJS.Timeout | undefined> = {};

// ETH token address on Starknet Sepolia
const ETH_TOKEN_ADDRESS =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

// Define the graph state for message history
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
});


// Define the tools for the agent to use

// Tool to send ETH transactions on Starknet Sepolia testnet
// Takes recipient address and ETH amount as input
// Prompts user for confirmation before sending
// Returns transaction hash and Starkscan link on success
// Handles errors and returns error messages on failure
const sendEthTool = tool(
  async ({ recipientAddress, amountInEth }, options) => {
    try {
      const chatId = options.metadata.thread_id;
      const account = await getAccount(chatId);

      if (!account) {
        return "Account does not exist, you need to create one first.";
      }

      // Convert ETH to wei (ETH * 10^18)
      const amountInWei = BigInt(
        Math.floor(parseFloat(amountInEth) * 1e18)
      ).toString();

      // ETH transfer call
      const result = await account.execute({
        contractAddress: ETH_TOKEN_ADDRESS,
        entrypoint: "transfer",
        calldata: [recipientAddress, amountInWei, "0"],
      });

      return `Transaction submitted to Sepolia. Hash: ${result.transaction_hash}
            View on Starkscan: https://sepolia.starkscan.co/tx/${result.transaction_hash}`;
    } catch (error: unknown) {
      if (error instanceof Error) {
        return `Error sending ETH: ${error.message}`;
      }
      return `Error sending ETH: Unknown error occurred`;
    }
  },
  {
    name: "send_eth",
    description: "Send ETH to an address on Starknet Sepolia testnet",
    schema: z.object({
      recipientAddress: z.string().describe("The recipient's Starknet address"),
      amountInEth: z.string().describe("The amount of ETH to send"),
    }),
  }
);

// Define the swap function
const swapTool = tool(
  async (input: { tokenInAddress: string; tokenOutAddress: string; amountIn: string }, options) => {
    try {
      const chatId = options.metadata.thread_id;
      const account = await getAccount(chatId);
      if (!account) {
        return "Account does not exist, you need to create one first.";
      }

      const normalizedTokenIn = input.tokenInAddress.toLowerCase() === 'eth' 
        ? ETH_ADDRESS 
        : input.tokenInAddress.toLowerCase() === 'strk'
          ? STRK_ADDRESS
          : input.tokenInAddress;

      const normalizedTokenOut = input.tokenOutAddress.toLowerCase() === 'eth'
        ? ETH_ADDRESS
        : input.tokenOutAddress.toLowerCase() === 'strk'
          ? STRK_ADDRESS
          : input.tokenOutAddress;

      const quote = await getQuote(normalizedTokenIn, normalizedTokenOut, input.amountIn);
      const expectedOutput = formatUnits(quote.buyAmount, 18);
      
      const result = await executeSwap(account, quote, {
        executeApprove: true,
        slippage: 0.01
      });

      return `✅ Swap executed successfully! You will receive ${expectedOutput} ${input.tokenOutAddress.toUpperCase()}. Transaction hash: ${result.transactionHash}`;
    } catch (error) {
      console.error("Error in swap:", error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return `Failed to execute swap: ${errorMessage}. Please try again with a different amount or check your balance.`;
    }
  },
  {
    name: "swap",
    description: "Swap tokens on Starknet",
    schema: z.object({
      tokenInAddress: z.string().describe("The address of the token to swap from"),
      tokenOutAddress: z.string().describe("The address of the token to swap to"),
      amountIn: z.string().describe("The amount of tokens to swap")
    })
  }
);
// Tool to get the current Starknet account address
const getCurrentAccountTool = tool(async ({}, options) => {
  const chatId = options.metadata.thread_id;
  const account = await getAccount(chatId);
  if (!account) {
    return 'Account does not exist, you need to create one first.';
  }
  return account.address;
}, {
  name: "get_starknet_account", 
  description: "Get the address of the current Starknet account"
});

// Tool to deploy a previously generated Starknet account
// Requires the account to be funded first
// Uses private key from storage to deploy the account contract
// Saves the deployed account credentials to storage
// Returns the deployed account address
const deployStarknetAccountTool = tool(async ({}, options) => {
  if (STARKNET_ACCOUNT_ADDRESS && STARKNET_PRIVATE_KEY) {
    return 'The account is set in the env and cannot be changed.'
  }

  const chatId = options.metadata.thread_id;
  const privateKey = await readFromStorage(`${chatId}:generatedAccountPrivateKey`);

  const { OZcontractAddress } = await deployAccount(privateKey);

  await saveToStorage(`${chatId}:privateKey`, privateKey);
  await saveToStorage(`${chatId}:accountAddress`, OZcontractAddress);

  return `Account deployed. Address: ${OZcontractAddress}`;
}, {
  name: "deploy_starknet_account",
  description: `Deploys the Starknet account / wallet.
  If wallet already exists, it will overwrite it.
  This is the last step in account creation.`
})

// Tool to generate a new Starknet account
// Creates new account credentials but does not deploy the contract
// Saves private key to storage for later deployment
// Returns the account address for funding
const generateStarknetAccountTool = tool(async ({}, options) => {
  if (STARKNET_ACCOUNT_ADDRESS && STARKNET_PRIVATE_KEY) {
    return 'The account is set in the env and cannot be changed.'
  }
  const { privateKey: newPrivateKey, OZcontractAddress } = await generateAccount();

  const chatId = options.metadata.thread_id
  await saveToStorage(`${chatId}:generatedAccountPrivateKey`, newPrivateKey);

  return `Here is the new account address: ${OZcontractAddress} . Please send some funds to it using the faucet: https://starknet-faucet.vercel.app . Let me know when you're done and I will deploy the account.`;
}, {
  name: "generate_starknet_account",
  description: `Generates a new Starknet account address.
    If one already exists, it will overwrite it.
    This is the first step in account creation.
    After this the user needs to fund the address and when it is funded we need to deploy the account.`
})

// Tool to fetch latest crypto news
const getNewsTool = tool(
  async () => {
    return JSON.stringify(await getNews());
  },
  {
    name: "get_news",
    description: "Get the latest crypto news",
  }
);

// Tool to start a periodic background action
// Takes an action description and interval in seconds
// Creates a new interval that executes the action periodically
// Clears any existing interval before starting new one
const startBackgroundAction = tool(
  async ({ whatToDo, intervalInSeconds }, options) => {
    const chatId = options.metadata.thread_id;

    if (backgroundActionIntervals[chatId]) {
      clearInterval(backgroundActionIntervals[chatId]);
      backgroundActionIntervals[chatId] = undefined;
    }
    const doAction = async () => {
      const message = whatToDo;

      const finalState = await app.invoke(
        { messages: [new HumanMessage(message)] },
        { configurable: { thread_id: Number(chatId) } }
      );
      bot.telegram.sendMessage(chatId,finalState.messages[finalState.messages.length - 1].content)

      // console.log("\n------UPDATE------\n");
      // console.log(finalState.messages[finalState.messages.length - 1].content);
      // console.log("\n-------------------\n");

      // Move the cursor back to the input line
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 1); // Clear the current line
      rl.prompt(); // Show the prompt again
    };
    backgroundActionIntervals[chatId] = await setInterval(
      doAction,
      intervalInSeconds * 1000
    );
    return "Started.";
  },
  {
    name: "start_background_action",
    description:
      "Call to start a loop that executes an action every X seconds. Or stop the current loop and start a new one.",
    schema: z.object({
      whatToDo: z
        .string()
        .describe("The action that you want to execute every X second."),
      intervalInSeconds: z
        .number()
        .describe(
          "The number of seconds that needs to pass before the news are fetched again."
        ),
    }),
  }
);

// Tool to stop the current background action
const stopBackgroundAction = tool(async ({}, options) => {
  const chatId = options.metadata.thread_id;
  if (backgroundActionIntervals[chatId]) {
    clearInterval(backgroundActionIntervals[chatId]);
    backgroundActionIntervals[chatId] = undefined;
  }
  return "Stopped.";
}, {
  name: "stop_background_action",
  description: "Stop the currently running background action loop"
});

// Initialize available tools
const tools = [
  sendEthTool,
  checkBalanceTool,
  startBackgroundAction,
  stopBackgroundAction,
  getNewsTool,
  getCurrentAccountTool,
  generateStarknetAccountTool,
  deployStarknetAccountTool,
  swapTool
];
const toolNode = new ToolNode(tools);

const model = new ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0,
}).bindTools(tools);

function shouldContinue(state: typeof StateAnnotation.State) {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1] as AIMessage;

  if (lastMessage.tool_calls?.length) {
    return "tools";
  }
  return "__end__";
}

async function callModel(state: typeof StateAnnotation.State) {
  const messages = state.messages;
  const response = await model.invoke(messages);
  return { messages: [response] };
}

const workflow = new StateGraph(StateAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

const checkpointer = new MemorySaver();
const app = workflow.compile({ checkpointer });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

bot.on(message("text"), async (ctx) => {
  if (!ctx.chat.id) return;

  // Indicate to the user that the agent is typing
  await ctx.persistentChatAction("typing", async () => {
    // Process user message and generate AI response
    const finalState = await app.invoke(
      { messages: [new HumanMessage(ctx.message.text)] },
      { configurable: { thread_id: Number(ctx.chat.id) } }
    );
    // Send the response
    ctx.reply(finalState.messages[finalState.messages.length - 1].content);
  });
});

// async function askQuestion() {
//   while (true) {
//     const question = await new Promise<string>((resolve) => {
//       rl.question('Ask a question (or type "exit" to quit): ', resolve);
//     });

//     if (question.toLowerCase() === "exit") {
//       if (backgroundActionInterval) {
//         clearInterval(backgroundActionInterval);
//         backgroundActionInterval = undefined;
//       }
//       rl.close();
//       break;
//     }

//     const finalState = await app.invoke(
//       { messages: [new HumanMessage(question)] },
//       { configurable: { thread_id: "42" } }
//     );
//     // response of the agent
//     console.log(finalState.messages[finalState.messages.length - 1].content);
//     console.log("\n-------------------\n");
//   }
// }

// askQuestion();
bot.launch();
