'use strict';

import * as vscode from 'vscode';
import OpenAI from 'openai';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import sharp from 'sharp';

// let resultUrl = 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-GCifzsS2YEPJFMLyBSfXg6ue/user-rMIIzmDnrKmSkPD9JXdfwLym/img-XqDsKppqvxUSpyhdkSwNMhxn.png?st=2023-11-12T18%3A59%3A05Z&se=2023-11-12T20%3A59%3A05Z&sp=r&sv=2021-08-06&sr=b&rscd=inline&rsct=image/png&skoid=6aaadede-4fb3-4698-a8f6-684d7786b067&sktid=a48cca56-e6da-484e-a814-9c849652bcb3&skt=2023-11-12T13%3A05%3A10Z&ske=2023-11-13T13%3A05%3A10Z&sks=b&skv=2021-08-06&sig=J1hNtHHFB1DCqo6GIS%2Bj3u3PcqZwLzpNajKbT8SPBug%3D';
let resultUrl: string | undefined;

export function activate(extContext: vscode.ExtensionContext) {

	const agent = vscode.chat.createChatAgent('dalle', async (request, context, progress, token) => {
		const userPrompt = request.prompt || 'A photo of a bicyclist carrying a laptop and writing code while simultaneously riding a bike.';

		// const access = await vscode.chat.requestChatAccess('copilot');
		// access.makeRequest([
		// 	{ role: vscode.ChatMessageRole.System, content: 'You write creative prompts for an AI image generator. The user' },
		// 	{ role: vscode.ChatMessageRole.User, content: userPrompt }
		// ], { }, token);

		if (!resultUrl) {
			const key = await getUserAiKey(extContext);
			if (!key) {
				throw new Error('Missing OpenAI API key');
			}

			const openai = new OpenAI({ apiKey: key });
			const imageGen = await openai.images.generate({
				prompt: userPrompt,
				model: "dall-e-3",
				n: 1,
				size: '1024x1024',
				quality: "standard",
			});
			resultUrl = imageGen.data[0].url!;
		}

		console.log(resultUrl);

		const randomFileName = crypto.randomBytes(20).toString('hex');
		const tempFileWithoutExtension = path.join(os.tmpdir(), 'chat-agent-dalle', `${randomFileName}`);
		const tmpFilePath = tempFileWithoutExtension + '.png';
		console.log(tmpFilePath);

		await downloadFile(resultUrl!, tmpFilePath);

		const smallFilePath = tempFileWithoutExtension + '-small.png';
		const inputBuffer = await fs.promises.readFile(tmpFilePath);
		await sharp(inputBuffer)
			.resize({ width: 400 })
			.toFile(smallFilePath);

		const content = `Here ya go:\n\n![image](file://${smallFilePath})\n\nHave a great day!`;
		progress.report({ content });

		return {};
	});

	extContext.subscriptions.push(agent);
}

export function deactivate() {
}

const keyName = 'openai.aiKey';
async function getUserAiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const storedKey = await context.secrets.get(keyName);
	if (storedKey) {
		return storedKey;
	} else {
		const newKey = await vscode.window.showInputBox({ placeHolder: 'Enter your OpenAI API key', prompt: 'You can create an API key [here](https://platform.openai.com/api-keys)' });
		if (newKey) {
			context.secrets.store(keyName, newKey);
			return newKey;
		} else {
			return;
		}
	}
}

async function downloadFile(url: string, destPath: string, headers?: Record<string, string>): Promise<void> {
	await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

	return new Promise((resolve, reject) => {
		https.get(url, { headers }, (response) => {
			if (response.headers.location) {
				console.log(`Following redirect to ${response.headers.location}`);
				return downloadFile(response.headers.location, destPath).then(resolve, reject);
			}

			if (response.statusCode === 404) {
				return reject(new Error(`File not found: ${url}`));
			}

			const file = fs.createWriteStream(destPath);
			response.pipe(file);
			file.on('finish', () => {
				file.close();
				resolve();
			});
			file.on('error', (err) => {
				file.close();
				reject(err);
			});
		}).on('error', (err) => {
			fs.unlink(destPath, () => reject(err));
		});
	});
}