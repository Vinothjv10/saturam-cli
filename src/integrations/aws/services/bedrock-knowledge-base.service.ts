import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { resolveAwsClientConfig } from "../utils/aws-credentials.util";

const logger = getLogger("BedrockKnowledgeBaseService");

export interface RetrievedChunk {
    content: string;
    score?: number;
    location?: string;
}

@Service()
export class BedrockKnowledgeBaseService {
    private client: import("@aws-sdk/client-bedrock-agent-runtime").BedrockAgentRuntimeClient | undefined;

    constructor(private readonly config: ConfigService) {}

    private async getClient(): Promise<import("@aws-sdk/client-bedrock-agent-runtime").BedrockAgentRuntimeClient> {
        if (this.client) return this.client;

        const { BedrockAgentRuntimeClient } = await import("@aws-sdk/client-bedrock-agent-runtime");
        const cloudConfig = await this.config.getAWSCloudConfig();
        const clientConfig = await resolveAwsClientConfig(cloudConfig);

        this.client = new BedrockAgentRuntimeClient(clientConfig);
        return this.client;
    }

    /**
     * Retrieves the most relevant document chunks from the configured Bedrock Knowledge Base for a query.
     */
    public async retrieve(query: string, options?: { numberOfResults?: number }): Promise<RetrievedChunk[]> {
        const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");
        const { knowledgeBaseId } = await this.config.getBedrockKnowledgeBaseConfig();
        const client = await this.getClient();

        logger.debug(`Retrieving from Bedrock Knowledge Base ${knowledgeBaseId}: "${query}"`);

        try {
            const response = await client.send(
                new RetrieveCommand({
                    knowledgeBaseId,
                    retrievalQuery: { text: query },
                    retrievalConfiguration: options?.numberOfResults
                        ? { vectorSearchConfiguration: { numberOfResults: options.numberOfResults } }
                        : undefined,
                }),
            );

            return (response.retrievalResults ?? []).map((result) => ({
                content: result.content?.text ?? "",
                score: result.score,
                location: result.location?.s3Location?.uri ?? result.location?.webLocation?.url,
            }));
        } catch (err) {
            throw new Error(
                `Failed to retrieve from Bedrock Knowledge Base ${knowledgeBaseId}: ${(err as Error).message}`,
            );
        }
    }
}
