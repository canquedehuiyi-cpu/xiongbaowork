import { z } from "zod";

export const credentialFormSchema = z.object({
  kind: z.enum(["model", "connector"]),
  provider: z.string().trim().min(1, "提供方为必填项。"),
  keyId: z.string().trim().min(1, "密钥 ID 为必填项。"),
  plaintext: z.string().min(1, "密钥为必填项。"),
});

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
