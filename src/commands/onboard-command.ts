import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { getLogger } from "log4js";
import { resolve } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { OnboardConfigSchema, OnboardService } from "../services/onboarding/onboard.service";
import { TypedCommand, TypedInputs } from "./base";

const logger = getLogger("OnboardCommand");

const INPUTS = [
    {
        name: "configOrSheet",
        description: "Path to the onboarding config JSON file, or Google Sheet URL/ID (default: .sateng/onboarding.json)",
        schema: z.string().optional(),
        argument: true,
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

    constructor(private readonly onboardService: OnboardService) { }

    public async execute(inputs: TypedInputs<typeof INPUTS>): Promise<void> {
        const cwd = process.env.SATENG_ORIGINAL_CWD ?? process.cwd();
        const arg = inputs.configOrSheet;

        const isGoogleSheet = arg && (
            arg.includes("docs.google.com/spreadsheets") ||
            /^[a-zA-Z0-9-_]{44}$/.test(arg)
        );

        if (isGoogleSheet) {
            const spreadsheetId = arg.includes("docs.google.com/spreadsheets")
                ? arg.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || arg
                : arg;

            logger.info(`Running onboarding sync directly from Google Sheet ID: ${spreadsheetId}`);
            try {
                const parsedConfig = {
                    onboardingSheets: [
                        { spreadsheetId }
                    ]
                };
                await this.onboardService.sync(parsedConfig, cwd);
            } catch (err) {
                logger.error(`Failed to execute onboarding sync from Google Sheet: ${(err as Error).message}`);
            }
            return;
        }

        const configPath = arg ? resolve(arg) : resolve(cwd, ".sateng/onboarding.json");

        logger.info(`Loading onboarding configuration from: ${configPath}`);

        if (!existsSync(configPath)) {
            logger.error(`Configuration file not found: ${configPath}`);
            logger.info("Please create a '.sateng/onboarding.json' file with your onboarding documentation details.");
            return;
        }

        try {
            const rawContent = await readFile(configPath, "utf8");
            const parsedConfig = OnboardConfigSchema.parse(JSON.parse(rawContent));
            await this.onboardService.sync(parsedConfig, cwd);
        } catch (err) {
            logger.error(`Failed to execute onboarding sync: ${(err as Error).message}`);
        }
    }
}
