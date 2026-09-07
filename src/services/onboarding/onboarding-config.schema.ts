import { z } from "zod";

/**
 * Zod schemas for the onboarding config domain (.sateng/onboarding.json), kept separate from
 * ConfigService's own config (personal/project/session) — ConfigService only depends on
 * OnboardConfigSchema/OnboardConfig to implement loadOnboardingConfig().
 */

export const OnboardPageSchema = z.union([
    z.string(),
    z.object({
        id: z.string(),
        outputPath: z.string().optional(),
    }),
]);

export const OnboardTicketSchema = z.union([
    z.string(),
    z.object({
        key: z.string(),
        outputPath: z.string().optional(),
    }),
]);

export const OnboardDocSchema = z.union([
    z.string(),
    z.object({
        id: z.string(),
        outputPath: z.string().optional(),
    }),
]);

export const OnboardConfluenceProjectConfig = z.object({
    baseUrl: z.string().optional(),
    space: z.string().optional(),
    pages: z.array(OnboardPageSchema).optional(),
});

export const OnboardJiraProjectConfig = z.object({
    baseUrl: z.string().optional(),
    tickets: z.array(OnboardTicketSchema).optional(),
    jql: z.string().optional(),
});

export const OnboardGoogleSheetsConfig = z.object({
    spreadsheetId: z.string(),
    /** A1 notation range e.g. "Sheet1!A:E". Defaults to all data in the first sheet. */
    range: z.string().optional(),
});

export const OnboardSheetLinksConfig = OnboardGoogleSheetsConfig;

export const OnboardProjectConfig = z.object({
    confluence: OnboardConfluenceProjectConfig.optional(),
    jira: OnboardJiraProjectConfig.optional(),
    googleDocs: z
        .object({
            docs: z.array(OnboardDocSchema).optional(),
        })
        .optional(),
    googleSheets: OnboardGoogleSheetsConfig.optional(),
    onboardingSheets: z.array(OnboardGoogleSheetsConfig).optional(),
});

export const OnboardConfigSchema = z.object({
    confluence: z
        .object({
            baseUrl: z.string().optional(),
            pages: z.array(OnboardPageSchema).optional(),
            spaces: z.array(z.string()).optional(),
        })
        .optional(),
    jira: z
        .object({
            baseUrl: z.string().optional(),
            tickets: z.array(OnboardTicketSchema).optional(),
        })
        .optional(),
    googleDocs: z
        .object({
            docs: z.array(OnboardDocSchema).optional(),
        })
        .optional(),
    googleSheets: OnboardGoogleSheetsConfig.optional(),
    onboardingSheets: z.array(OnboardGoogleSheetsConfig).optional(),
    projects: z.record(z.string(), OnboardProjectConfig).optional(),
});

export type OnboardConfig = z.infer<typeof OnboardConfigSchema>;
