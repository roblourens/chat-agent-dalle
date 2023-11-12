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

export function activate(extContext: vscode.ExtensionContext) {

	const agent = vscode.chat.createChatAgent('dalle', async (request, context, progress, token) => {
		let imageGenPrompt = request.prompt || 'A photo of a bicyclist in Seattle carrying a laptop and writing code while simultaneously riding a bike.';

		const reg = /(^|\s)\[(#)([\w_\-]+)(:[\w_\-\.]+)?\]\(values:([\w_\-]+)(:[\w_\-\.]+)?\)/ig;
		imageGenPrompt = imageGenPrompt.replace(reg, '');
		if (request.variables['git']) {
			const git = request.variables['git'][0];
			let fullBranchName = git.value.match(/Current Branch name: (.*)/i)![1];
			const branchName = fullBranchName.split('/')[1] || fullBranchName;
			const access = await vscode.chat.requestChatAccess('copilot');
			const promptRequest = access.makeRequest([
				{ role: vscode.ChatMessageRole.System, content: 'You write creative prompts for an AI image generator. The user will give a short phrase, and you must generate a prompt for DALL-E based on that phrase. Don\'t forget to include the art style for the image. For example, it could be an oil painting, a photograph, a cartoon, a charcoal drawing, or something else. Reply with the prompt and no other text.' },
				{ role: vscode.ChatMessageRole.User, content: branchName },
			], {}, token);

			let prompt = '';
			for await (const chunk of promptRequest.response) {
				prompt += chunk;
			}

			imageGenPrompt = prompt;

			progress.report({ content: `**Branch name**: ${fullBranchName}\n\n` });
			progress.report({ content: `**Prompt**: ${imageGenPrompt}\n\n` });
		}

		let resultUrl: string | undefined;
		if (!resultUrl) {
			const key = await getUserAiKey(extContext);
			if (!key) {
				throw new Error('Missing OpenAI API key');
			}

			const openai = new OpenAI({ apiKey: key });
			const imageGen = await openai.images.generate({
				prompt: imageGenPrompt,
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

		const content = `Here ya go:
		
![image](file://${smallFilePath})

[Full size](${resultUrl})

Have a great day!`;
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