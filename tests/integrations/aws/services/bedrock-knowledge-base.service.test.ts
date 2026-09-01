import { BedrockKnowledgeBaseService } from "../../../../src/integrations/aws/services/bedrock-knowledge-base.service";
import { ConfigService } from "../../../../src/services/config-service";

const mockSend = jest.fn();
const mockBedrockClient = jest.fn().mockImplementation(() => ({ send: mockSend }));

jest.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
    BedrockAgentRuntimeClient: mockBedrockClient,
    RetrieveCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe("BedrockKnowledgeBaseService", () => {
    let service: BedrockKnowledgeBaseService;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            getAWSCloudConfig: jest.fn().mockResolvedValue({ enabled: true, awsRegion: "us-east-1" }),
            getBedrockKnowledgeBaseConfig: jest
                .fn()
                .mockResolvedValue({ knowledgeBaseId: "KB123", region: "ap-south-1" }),
        } as any;
        service = new BedrockKnowledgeBaseService(mockConfig);
    });

    it("retrieve maps results and passes the query to RetrieveCommand", async () => {
        mockSend.mockResolvedValueOnce({
            retrievalResults: [
                {
                    content: { text: "chunk one" },
                    score: 0.9,
                    location: { s3Location: { uri: "s3://bucket/key.md" } },
                    metadata: { project: "saturam", category: "google-docs" },
                },
            ],
        });

        const results = await service.retrieve("what is the auth flow?", { numberOfResults: 3 });

        expect(results).toEqual([
            {
                content: "chunk one",
                score: 0.9,
                location: "s3://bucket/key.md",
                metadata: { project: "saturam", category: "google-docs" },
            },
        ]);
        expect(mockBedrockClient).toHaveBeenCalledWith(expect.objectContaining({ region: "ap-south-1" }));
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    knowledgeBaseId: "KB123",
                    retrievalQuery: { text: "what is the auth flow?" },
                    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3 } },
                }),
            }),
        );
    });

    it("retrieve throws a descriptive error when the SDK call fails", async () => {
        mockSend.mockRejectedValueOnce(new Error("AccessDeniedException"));

        await expect(service.retrieve("query")).rejects.toThrow(
            "Failed to retrieve from Bedrock Knowledge Base KB123: AccessDeniedException",
        );
    });
});
