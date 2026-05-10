import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type {
  CanonicalCredentials, CanonicalProviderName
} from "@statewalker/ai-providers";
import { Button, Input, Label } from "@statewalker/shadcn-react";
import { testCanonicalConnection, type TestResult } from "./test-connection.js";

const schema = z.object({
  apiKey: z.string().trim().min(1, "API key is required"),
});
type FormValues = z.infer<typeof schema>;

export interface CanonicalFormProps {
  name: CanonicalProviderName;
  initial?: CanonicalCredentials;
  onSave: (credentials: CanonicalCredentials) => Promise<void>;
  onClear: () => Promise<void>;
}

/** API-key-only form for OpenAI, Anthropic, and Google. */
export function CanonicalForm({
  name,
  initial,
  onSave,
  onClear,
}: CanonicalFormProps): React.ReactElement {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    getValues,
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { apiKey: initial?.apiKey ?? "" },
  });

  // Refresh form when the initial value changes (e.g., user opens a tab
  // after saving a key in another tab — the persisted config has updated).
  useEffect(() => {
    reset({ apiKey: initial?.apiKey ?? "" });
  }, [initial?.apiKey, reset]);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [reveal, setReveal] = useState(false);

  const onSubmit = handleSubmit(async (values) => {
    setTestResult(null);
    await onSave({ apiKey: values.apiKey.trim() });
  });

  const onTest = async (): Promise<void> => {
    setTestResult(null);
    const values = getValues();
    if (!values.apiKey?.trim()) {
      setTestResult({ ok: false, message: "Enter an API key first." });
      return;
    }
    setTesting(true);
    try {
      setTestResult(await testCanonicalConnection(name, values.apiKey.trim()));
    } finally {
      setTesting(false);
    }
  };

  const onClearClick = async (): Promise<void> => {
    await onClear();
    reset({ apiKey: "" });
    setTestResult(null);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${name}-apiKey`}>API key</Label>
        <div className="relative">
          <Input
            id={`${name}-apiKey`}
            type={reveal ? "text" : "password"}
            // `new-password` is more reliably ignored by browser
            // password-manager autofill than `off`, which can still
            // trigger cross-form value injection.
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            spellCheck={false}
            {...register("apiKey")}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "Hide API key" : "Show API key"}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
          >
            {reveal ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        {errors.apiKey ? (
          <p className="text-xs text-destructive">{errors.apiKey.message}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? <Loader2 className="animate-spin" /> : null}
          Test connection
        </Button>
        {initial?.apiKey ? (
          <Button type="button" variant="ghost" onClick={onClearClick}>
            Clear
          </Button>
        ) : null}
      </div>

      {testResult ? (
        <p
          className={
            testResult.ok
              ? "text-xs text-green-600 dark:text-green-500"
              : "text-xs text-destructive"
          }
        >
          {testResult.message}
        </p>
      ) : null}
    </form>
  );
}
