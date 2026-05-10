import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  type CustomProvider,
  newCustomProviderId,
} from "@statewalker/ai-providers";
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
} from "@statewalker/shadcn-react";
import { type TestResult, testCustomConnection } from "./test-connection.js";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  baseURL: z.string().trim().url("Must be a valid URL"),
  apiKey: z.string().trim().min(1, "API key is required"),
});
type FormValues = z.infer<typeof schema>;

interface CustomProviderFormProps {
  initial: CustomProvider;
  onSave: (next: CustomProvider) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function CustomProviderForm({
  initial,
  onSave,
  onDelete,
}: CustomProviderFormProps): React.ReactElement {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
    getValues,
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial.name,
      baseURL: initial.baseURL,
      apiKey: initial.apiKey,
    },
  });

  // Reset when the persisted entry changes (e.g., id-stable replacement
  // after parent rebuild).
  useEffect(() => {
    reset({
      name: initial.name,
      baseURL: initial.baseURL,
      apiKey: initial.apiKey,
    });
  }, [initial.id, initial.name, initial.baseURL, initial.apiKey, reset]);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [reveal, setReveal] = useState(false);

  const onSubmit = handleSubmit(async (values) => {
    setTestResult(null);
    await onSave({
      id: initial.id,
      name: values.name.trim(),
      baseURL: values.baseURL.trim(),
      apiKey: values.apiKey.trim(),
    });
  });

  const onTest = async (): Promise<void> => {
    setTestResult(null);
    const values = getValues();
    if (!values.apiKey?.trim() || !values.baseURL?.trim()) {
      setTestResult({ ok: false, message: "Fill Base URL and API key first." });
      return;
    }
    setTesting(true);
    try {
      setTestResult(
        await testCustomConnection(values.apiKey.trim(), values.baseURL.trim()),
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${initial.id}-name`}>Name</Label>
            <Input
              id={`${initial.id}-name`}
              placeholder="LM Studio, Ollama, …"
              {...register("name")}
            />
            {errors.name ? (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${initial.id}-baseURL`}>Base URL</Label>
            <Input
              id={`${initial.id}-baseURL`}
              type="url"
              placeholder="http://localhost:1234/v1"
              {...register("baseURL")}
            />
            {errors.baseURL ? (
              <p className="text-xs text-destructive">
                {errors.baseURL.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${initial.id}-apiKey`}>API key</Label>
            <div className="relative">
              <Input
                id={`${initial.id}-apiKey`}
                type={reveal ? "text" : "password"}
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
              <p className="text-xs text-destructive">
                {errors.apiKey.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" disabled={isSubmitting || !isDirty}>
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
            <Button
              type="button"
              variant="ghost"
              className="ml-auto text-destructive"
              onClick={() => void onDelete(initial.id)}
            >
              <Trash2 /> Remove
            </Button>
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
      </CardContent>
    </Card>
  );
}

export interface CustomProvidersListProps {
  providers: CustomProvider[];
  onSave: (next: CustomProvider) => Promise<void>;
  onAdd: (next: CustomProvider) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function CustomProvidersList({
  providers,
  onSave,
  onAdd,
  onDelete,
}: CustomProvidersListProps): React.ReactElement {
  const handleAdd = async (): Promise<void> => {
    await onAdd({
      id: newCustomProviderId(),
      name: "",
      baseURL: "",
      apiKey: "",
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No OpenAI-compatible endpoints yet. Add one to point at LM Studio,
          Ollama, llama.cpp, OpenRouter, or any other API that speaks the OpenAI
          protocol.
        </p>
      ) : (
        providers.map((p) => (
          <CustomProviderForm
            key={p.id}
            initial={p}
            onSave={onSave}
            onDelete={onDelete}
          />
        ))
      )}
      <div>
        <Button type="button" variant="outline" onClick={handleAdd}>
          <Plus /> Add OpenAI-compatible endpoint
        </Button>
      </div>
    </div>
  );
}
