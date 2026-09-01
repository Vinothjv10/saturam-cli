import { input } from "@inquirer/prompts";
import { getLogger } from "log4js";
import { resolve } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { BedrockKnowledgeBaseService } from "../integrations/aws/services/bedrock-knowledge-base.service";
import { ConfigService } from "../services/config-service";
import { OnboardService } from "../services/onboarding/onboard.service";
import { TypedCommand, TypedInputs } from "./base";

const logger = getLogger("OnboardCommand");

const INPUTS = [
    {
        name: "configOrSheet",
        description:
            "Path to the onboarding config JSON file, or Google Sheet URL/ID (default: .sateng/onboarding.json)",
        schema: z.string().optional(),
        argument: true,
    },
    {
        name: "project-name",
        description:
            "Override the project name used for output folders (e.g. onboarding/confluence/<project-name>/...) for every document fetched in this run",
        schema: z.string().optional(),
    },
    {
        name: "upload-to-s3",
        description:
            "Upload the documents synced in this run to the configured S3 bucket (requires AWS S3 to be configured via 'sat-cli init' → Cloud)",
        schema: z.boolean().optional(),
    },
    {
        name: "list",
        description: "List locally synced onboarding documents, grouped by project name, instead of syncing",
        schema: z.boolean().optional(),
    },
    {
        name: "knowledge-base",
        description:
            "Interactively ask questions against the configured Bedrock Knowledge Base and print retrieved chunks (Retrieve only — no answer generation), instead of syncing. Requires Bedrock Knowledge Base to be configured via 'sat-cli init' → Cloud",
        schema: z.boolean().optional(),
    },
] as const;

@Service()
export class OnboardCommand implements TypedCommand<typeof INPUTS> {
    readonly name = "onboard";
    readonly description =
        "Fetch and sync project onboarding documents locally (e.g. Confluence pages, Jira tickets, and Google Drive files)";
    readonly category = "common" as const;
    readonly aliases = ["ob", "onboarding"];
    readonly inputs = INPUTS;

    constructor(
        private readonly onboardService: OnboardService,
        private readonly configService: ConfigService,
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
    ) {}

    public async execute(inputs: TypedInputs<typeof INPUTS>): Promise<void> {
        if (inputs["knowledge-base"]) {
            await this.runKnowledgeBaseSearch();
            return;
        }

        if (inputs.list) {
            await this.onboardService.listSyncedDocuments();
            return;
        }

        const cwd = process.env.SATENG_ORIGINAL_CWD ?? process.cwd();
        const arg = inputs.configOrSheet;
        const projectNameOverride = inputs["project-name"];
        const uploadToS3 = inputs["upload-to-s3"];

        const isGoogleSheet = arg && (arg.includes("docs.google.com/spreadsheets") || /^[a-zA-Z0-9-_]{44}$/.test(arg));

        if (isGoogleSheet) {
            const spreadsheetId = arg.includes("docs.google.com/spreadsheets")
                ? arg.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || arg
                : arg;

            logger.info(`Running onboarding sync directly from Google Sheet ID: ${spreadsheetId}`);
            const parsedConfig = {
                onboardingSheets: [{ spreadsheetId }],
            };
            const { filesWritten } = await this.onboardService.sync(parsedConfig, cwd, projectNameOverride);
            if (uploadToS3) await this.onboardService.uploadToS3(filesWritten);
            return;
        }

        const configPath = arg ? resolve(arg) : resolve(cwd, ".sateng/onboarding.json");

        logger.info(`Loading onboarding configuration from: ${configPath}`);
        const parsedConfig = await this.configService.loadOnboardingConfig(configPath);
        const { filesWritten } = await this.onboardService.sync(parsedConfig, cwd, projectNameOverride);
        if (uploadToS3) await this.onboardService.uploadToS3(filesWritten);
    }

    private static readonly KB_EXIT_COMMANDS = new Set(["exit", "quit", ":q"]);

    /**
     * Interactive REPL: repeatedly prompts for a question, calls Bedrock Knowledge Base
     * Retrieve (no generation — equivalent to the AWS console's "Retrieve only" test mode),
     * and prints the ranked chunks. Exits on blank input, "exit"/"quit", or Ctrl+C.
     */
    private async runKnowledgeBaseSearch(): Promise<void> {
        logger.info("Bedrock Knowledge Base search (Retrieve only — no answer generation).");
        logger.info("Type a question and press Enter. Type 'exit' or leave blank to quit.\n");

        for (;;) {
            const question = await input({ message: "Question:" });
            const trimmed = question.trim();
            if (!trimmed || OnboardCommand.KB_EXIT_COMMANDS.has(trimmed.toLowerCase())) {
                logger.info("Exiting knowledge base search.");
                return;
            }

            try {
                const results = await this.knowledgeBase.retrieve(trimmed);
                if (results.length === 0) {
                    logger.info("No matching results found.\n");
                    continue;
                }

                logger.info(`\nFound ${results.length} result(s):`);
                results.forEach((result, index) => {
                    const scoreText = result.score !== undefined ? ` (score: ${result.score.toFixed(3)})` : "";
                    logger.info(`\n${index + 1}.${scoreText}`);
                    if (result.location) logger.info(`   source: ${result.location}`);
                    logger.info(`   ${result.content.trim()}`);
                });
                logger.info("");
            } catch (err) {
                logger.error(`Retrieval failed: ${(err as Error).message}\n`);
            }
        }
    }
}
