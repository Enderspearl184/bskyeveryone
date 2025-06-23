declare global {
  namespace NodeJS {
    interface ProcessEnv {
        BSKY_USERNAME: string,
        BSKY_PASSWORD: string,
        BSKY_LIST: string
    }
  }
}

// If this file has no import/export statements (i.e. is a script)
// convert it into a module by adding an empty export statement.
export {}