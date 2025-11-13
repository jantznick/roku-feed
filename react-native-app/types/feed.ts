export interface Video {
  url: string;
  quality: string;
  videoType: string;
  confirmedAt?: string;
}

export interface Content {
  dateAdded: string;
  duration: number;
  videos: Video[];
}

export interface Match {
  id: string;
  title: string;
  shortDescription: string;
  startTime: string;
  thumbnail: string;
  genres: string[];
  releaseDate: string;
  content: Content;
}

export interface Feed {
  providerName: string;
  lastUpdated: string;
  language: string;
  [key: string]: any; // For dynamic league categories
}

export interface Settings {
  feedUrl: string;
  favoriteTeams: string[];
}


