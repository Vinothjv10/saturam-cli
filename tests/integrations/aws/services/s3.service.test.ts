import { S3Service } from "../../../../src/integrations/aws/services/s3.service";
import { ConfigService } from "../../../../src/services/config-service";

const mockSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
}));

describe("S3Service", () => {
    let service: S3Service;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            getAWSCloudConfig: jest.fn().mockResolvedValue({ enabled: true, awsRegion: "us-east-1" }),
            getS3Config: jest.fn().mockResolvedValue({ bucket: "my-bucket", prefix: "docs", region: "us-east-1" }),
        } as any;
        service = new S3Service(mockConfig);
    });

    it("getObject fetches from the prefixed key and returns a Buffer", async () => {
        mockSend.mockResolvedValueOnce({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([104, 105])) },
        });

        const result = await service.getObject("file.md");

        expect(result).toEqual(Buffer.from("hi"));
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: { Bucket: "my-bucket", Key: "docs/file.md" } }),
        );
    });

    it("putObject writes to the prefixed key", async () => {
        mockSend.mockResolvedValueOnce({});

        await service.putObject("file.md", "content", "text/markdown");

        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: { Bucket: "my-bucket", Key: "docs/file.md", Body: "content", ContentType: "text/markdown" },
            }),
        );
    });

    it("listObjects paginates through all pages and returns keys", async () => {
        mockSend
            .mockResolvedValueOnce({
                Contents: [{ Key: "docs/a.md" }],
                IsTruncated: true,
                NextContinuationToken: "token-2",
            })
            .mockResolvedValueOnce({ Contents: [{ Key: "docs/b.md" }], IsTruncated: false });

        const keys = await service.listObjects();

        expect(keys).toEqual(["docs/a.md", "docs/b.md"]);
        expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("getObject throws a descriptive error when the SDK call fails", async () => {
        mockSend.mockRejectedValueOnce(new Error("Access Denied"));

        await expect(service.getObject("file.md")).rejects.toThrow(
            "Failed to get s3://my-bucket/docs/file.md: Access Denied",
        );
    });
});
