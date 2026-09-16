import type { ProfanityMode, PromptLocale } from '../memory/chatSettings';
import type { Mood } from '../memory/moodDiary';
import { agentPrompt as enAgentPrompt, identityPrompt as enIdentityPrompt, imageInputFailurePrompt as enImageInputFailurePrompt, languageGuidance as enLanguageGuidance, moodGuidance as enMoodGuidance, photoDownloadFailurePrompt as enPhotoDownloadFailurePrompt } from './en/agent';
import { agentPrompt as ruAgentPrompt, identityPrompt as ruIdentityPrompt, imageInputFailurePrompt as ruImageInputFailurePrompt, languageGuidance as ruLanguageGuidance, moodGuidance as ruMoodGuidance, photoDownloadFailurePrompt as ruPhotoDownloadFailurePrompt } from './ru/agent';

export type AgentPromptMessages = {
  agentPrompt: string;
  identityPrompt: (identity: string) => string;
  imageInputFailurePrompt: (input: string, reason: string) => string;
  photoDownloadFailurePrompt: (caption: string | undefined, reason: string) => string;
  languageGuidance: (profanityMode: ProfanityMode) => string;
  moodGuidance: (mood: Mood) => string;
};

const prompts: Record<PromptLocale, AgentPromptMessages> = {
  ru: {
    agentPrompt: ruAgentPrompt,
    identityPrompt: ruIdentityPrompt,
    imageInputFailurePrompt: ruImageInputFailurePrompt,
    photoDownloadFailurePrompt: ruPhotoDownloadFailurePrompt,
    languageGuidance: ruLanguageGuidance,
    moodGuidance: ruMoodGuidance,
  },
  en: {
    agentPrompt: enAgentPrompt,
    identityPrompt: enIdentityPrompt,
    imageInputFailurePrompt: enImageInputFailurePrompt,
    photoDownloadFailurePrompt: enPhotoDownloadFailurePrompt,
    languageGuidance: enLanguageGuidance,
    moodGuidance: enMoodGuidance,
  },
};

export function agentPromptMessages(locale: PromptLocale): AgentPromptMessages {
  return prompts[locale];
}
