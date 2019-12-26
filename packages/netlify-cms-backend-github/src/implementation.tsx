import * as React from 'react';
import trimStart from 'lodash/trimStart';
import semaphore from 'semaphore';
import { stripIndent } from 'common-tags';
import {
  asyncLock,
  basename,
  getCollectionDepth,
  AsyncLock,
  Implementation,
  AssetProxy,
  Map,
  PersistOptions,
  ImplementationEntry,
  DisplayURL,
  DisplayURLObject,
  Collection,
  getBlobSHA,
} from 'netlify-cms-lib-util';
import AuthenticationPage from './AuthenticationPage';
import { get } from 'lodash';
import {
  UsersGetAuthenticatedResponse as GitHubUser,
  ReposListStatusesForRefResponseItem as GitHubCommitStatus,
} from '@octokit/rest';
import API, { Entry, UnpublishedBranchResult } from './API';
import GraphQLAPI from './GraphQLAPI';

const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * Keywords for inferring a status that will provide a deploy preview URL.
 */
const PREVIEW_CONTEXT_KEYWORDS = ['deploy'];

/**
 * Check a given status context string to determine if it provides a link to a
 * deploy preview. Checks for an exact match against `previewContext` if given,
 * otherwise checks for inclusion of a value from `PREVIEW_CONTEXT_KEYWORDS`.
 */
function isPreviewContext(context: string, previewContext: string) {
  if (previewContext) {
    return context === previewContext;
  }
  return PREVIEW_CONTEXT_KEYWORDS.some(keyword => context.includes(keyword));
}

/**
 * Retrieve a deploy preview URL from an array of statuses. By default, a
 * matching status is inferred via `isPreviewContext`.
 */
function getPreviewStatus(statuses: GitHubCommitStatus[], config: Map) {
  const previewContext = config.getIn<string>(['backend', 'preview_context']);
  return statuses.find(({ context }) => {
    return isPreviewContext(context, previewContext);
  });
}

export default class GitHub implements Implementation {
  lock: AsyncLock;
  api: API | null;
  config: Map;
  options: {
    proxied: boolean;
    API: API | null;
    useWorkflow?: boolean;
    initialWorkflowStatus: string;
  };
  originRepo: string;
  repo?: string;
  openAuthoringEnabled: boolean;
  useOpenAuthoring?: boolean;
  branch: string;
  apiRoot: string;
  token: string | null;
  squashMerges: string;
  useGraphql: boolean;
  _currentUserPromise?: Promise<GitHubUser>;
  _userIsOriginMaintainerPromises?: {
    [key: string]: Promise<boolean>;
  };

  constructor(config: Map, options = {}) {
    this.config = config;
    this.options = {
      proxied: false,
      API: null,
      initialWorkflowStatus: '',
      ...options,
    };

    if (!this.options.proxied && config.getIn(['backend', 'repo']) == null) {
      throw new Error('The GitHub backend needs a "repo" in the backend configuration.');
    }

    this.api = this.options.API || null;

    this.openAuthoringEnabled = config.getIn(['backend', 'open_authoring'], false);
    if (this.openAuthoringEnabled) {
      if (!this.options.useWorkflow) {
        throw new Error(
          'backend.open_authoring is true but publish_mode is not set to editorial_workflow.',
        );
      }
      this.originRepo = config.getIn(['backend', 'repo'], '');
    } else {
      this.repo = this.originRepo = config.getIn(['backend', 'repo'], '');
    }
    this.branch = config.getIn(['backend', 'branch'], 'master').trim();
    this.apiRoot = config.getIn(['backend', 'api_root'], 'https://api.github.com');
    this.token = '';
    this.squashMerges = config.getIn(['backend', 'squash_merges']);
    this.useGraphql = config.getIn(['backend', 'use_graphql']);
    this.lock = asyncLock();
  }

  async runWithLock(func: Function, message: string) {
    try {
      const acquired = await this.lock.acquire();
      if (!acquired) {
        console.warn(message);
      }

      const result = await func();
      return result;
    } finally {
      this.lock.release();
    }
  }

  authComponent() {
    const wrappedAuthenticationPage = (props: Record<string, unknown>) => (
      <AuthenticationPage {...props} backend={this} />
    );
    wrappedAuthenticationPage.displayName = 'AuthenticationPage';
    return wrappedAuthenticationPage;
  }

  restoreUser(user: { token: string }) {
    return this.openAuthoringEnabled
      ? this.authenticateWithFork({ userData: user, getPermissionToFork: () => true }).then(() =>
          this.authenticate(user),
        )
      : this.authenticate(user);
  }

  async pollUntilForkExists({ repo, token }: { repo: string; token: string }) {
    const pollDelay = 250; // milliseconds
    let repoExists = false;
    while (!repoExists) {
      repoExists = await fetch(`${this.apiRoot}/repos/${repo}`, {
        headers: { Authorization: `token ${token}` },
      })
        .then(() => true)
        .catch(err => {
          if (err && err.status === 404) {
            console.log('This 404 was expected and handled appropriately.');
            return false;
          } else {
            return Promise.reject(err);
          }
        });
      // wait between polls
      if (!repoExists) {
        await new Promise(resolve => setTimeout(resolve, pollDelay));
      }
    }
    return Promise.resolve();
  }

  async currentUser({ token }: { token: string }) {
    if (!this._currentUserPromise) {
      this._currentUserPromise = fetch(`${this.apiRoot}/user`, {
        headers: {
          Authorization: `token ${token}`,
        },
      }).then(res => res.json());
    }
    return this._currentUserPromise;
  }

  async userIsOriginMaintainer({
    username: usernameArg,
    token,
  }: {
    username?: string;
    token: string;
  }) {
    const username = usernameArg || (await this.currentUser({ token })).login;
    this._userIsOriginMaintainerPromises = this._userIsOriginMaintainerPromises || {};
    if (!this._userIsOriginMaintainerPromises[username]) {
      this._userIsOriginMaintainerPromises[username] = fetch(
        `${this.apiRoot}/repos/${this.originRepo}/collaborators/${username}/permission`,
        {
          headers: {
            Authorization: `token ${token}`,
          },
        },
      )
        .then(res => res.json())
        .then(({ permission }) => permission === 'admin' || permission === 'write');
    }
    return this._userIsOriginMaintainerPromises[username];
  }

  async forkExists({ token }: { token: string }) {
    try {
      const currentUser = await this.currentUser({ token });
      const repoName = this.originRepo.split('/')[1];
      const repo = await fetch(`${this.apiRoot}/repos/${currentUser.login}/${repoName}`, {
        method: 'GET',
        headers: {
          Authorization: `token ${token}`,
        },
      }).then(res => res.json());

      // https://developer.github.com/v3/repos/#get
      // The parent and source objects are present when the repository is a fork.
      // parent is the repository this repository was forked from, source is the ultimate source for the network.
      const forkExists =
        repo.fork === true &&
        repo.parent &&
        repo.parent.full_name.toLowerCase() === this.originRepo.toLowerCase();
      return forkExists;
    } catch {
      return false;
    }
  }

  async authenticateWithFork({
    userData,
    getPermissionToFork,
  }: {
    userData: { token: string };
    getPermissionToFork: () => Promise<boolean> | boolean;
  }) {
    if (!this.openAuthoringEnabled) {
      throw new Error('Cannot authenticate with fork; Open Authoring is turned off.');
    }
    const { token } = userData;

    // Origin maintainers should be able to use the CMS normally
    if (await this.userIsOriginMaintainer({ token })) {
      this.repo = this.originRepo;
      this.useOpenAuthoring = false;
      return Promise.resolve();
    }

    if (!(await this.forkExists({ token }))) {
      await getPermissionToFork();
    }

    const fork = await fetch(`${this.apiRoot}/repos/${this.originRepo}/forks`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
      },
    }).then(res => res.json());
    this.useOpenAuthoring = true;
    this.repo = fork.full_name;
    return this.pollUntilForkExists({ repo: fork.full_name, token });
  }

  async authenticate(state: { token: string }) {
    this.token = state.token;
    const apiCtor = this.useGraphql ? GraphQLAPI : API;
    this.api = new apiCtor({
      token: this.token,
      branch: this.branch,
      repo: this.repo,
      originRepo: this.originRepo,
      apiRoot: this.apiRoot,
      squashMerges: this.squashMerges,
      useOpenAuthoring: this.useOpenAuthoring,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    });
    const user = await this.api!.user();
    const isCollab = await this.api!.hasWriteAccess().catch(error => {
      error.message = stripIndent`
        Repo "${this.repo}" not found.

        Please ensure the repo information is spelled correctly.

        If the repo is private, make sure you're logged into a GitHub account with access.

        If your repo is under an organization, ensure the organization has granted access to Netlify
        CMS.
      `;
      throw error;
    });

    // Unauthorized user
    if (!isCollab) {
      throw new Error('Your GitHub user account does not have access to this repo.');
    }

    // Authorized user
    return { ...user, token: state.token, useOpenAuthoring: this.useOpenAuthoring };
  }

  logout() {
    this.token = null;
    if (this.api && this.api.reset && typeof this.api.reset === 'function') {
      return this.api.reset();
    }
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  async entriesByFolder(collection: Collection, extension: string) {
    const repoURL = this.useOpenAuthoring ? this.api!.originRepoURL : this.api!.repoURL;
    const files = await this.api!.listFiles(collection.get('folder') as string, {
      repoURL,
      depth: getCollectionDepth(collection),
    });
    const filteredFiles = files.filter(file => file.name.endsWith('.' + extension));
    return this.fetchFiles(filteredFiles, { repoURL });
  }

  entriesByFiles(collection: Collection) {
    const repoURL = this.useOpenAuthoring ? this.api!.originRepoURL : this.api!.repoURL;
    const files = collection
      .get('files')!
      .map(collectionFile => ({
        path: collectionFile!.get('file'),
        label: collectionFile!.get('label'),
        sha: null,
      }))
      .toArray();
    return this.fetchFiles(files, { repoURL });
  }

  fetchFiles = (
    files: { path: string; sha?: string | null }[],
    { repoURL = this.api!.repoURL } = {},
  ) => {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises = [] as Promise<ImplementationEntry | { error: boolean }>[];
    files.forEach(file => {
      promises.push(
        new Promise(resolve =>
          sem.take(() =>
            this.api!.readFile(file.path, file.sha, { repoURL })
              .then(data => {
                resolve({ file, data: data as string, error: false });
                sem.leave();
              })
              .catch((err = true) => {
                sem.leave();
                console.error(`failed to load file from GitHub: ${file.path}`);
                resolve({ error: err });
              }),
          ),
        ),
      );
    });
    return Promise.all(promises).then(loadedEntries =>
      loadedEntries.filter(loadedEntry => !((loadedEntry as unknown) as { error: boolean }).error),
    ) as Promise<ImplementationEntry[]>;
  };

  // Fetches a single entry.
  getEntry(collection: Collection, slug: string, path: string) {
    const repoURL = this.api!.originRepoURL;
    return this.api!.readFile(path, null, { repoURL }).then(data => ({
      file: { path },
      data: data as string,
    }));
  }

  getMedia(mediaFolder = this.config.get<string>('media_folder')) {
    return this.api!.listFiles(mediaFolder).then(files =>
      files.map(({ sha, name, size, path }) => {
        // load media using getMediaDisplayURL to avoid token expiration with GitHub raw content urls
        // for private repositories
        return { id: sha, name, size, displayURL: { id: sha, path }, path };
      }),
    );
  }

  async getMediaFile(path: string) {
    const blob = await this.api!.getMediaAsBlob(null, path);

    const name = basename(path);
    const fileObj = new File([blob], name);
    const url = URL.createObjectURL(fileObj);
    const id = await getBlobSHA(blob);

    return {
      id,
      displayURL: url,
      path,
      name,
      size: fileObj.size,
      file: fileObj,
      url,
    };
  }

  async getMediaDisplayURL(displayURL: DisplayURL) {
    const { id, path } = displayURL as DisplayURLObject;
    const mediaURL = await this.api!.getMediaDisplayURL(id, path);
    return mediaURL;
  }

  persistEntry(entry: Entry, mediaFiles: AssetProxy[] = [], options: PersistOptions) {
    // persistEntry is a transactional operation
    return this.runWithLock(
      () => this.api!.persistFiles(entry, mediaFiles, options),
      'Failed to acquire persist entry lock',
    );
  }

  async persistMedia(mediaFile: AssetProxy, options: PersistOptions) {
    try {
      await this.api!.persistFiles(null, [mediaFile], options);
      const { sha, path, fileObj } = mediaFile as AssetProxy & { sha: string };
      const displayURL = URL.createObjectURL(fileObj);
      return {
        id: sha,
        name: fileObj!.name,
        size: fileObj!.size,
        displayURL,
        path: trimStart(path, '/'),
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  deleteFile(path: string, commitMessage: string) {
    return this.api!.deleteFile(path, commitMessage);
  }

  async loadMediaFile(file: { sha: string; path: string }) {
    return this.api!.getMediaAsBlob(file.sha, file.path).then(blob => {
      const name = basename(file.path);
      const fileObj = new File([blob], name);
      return {
        id: file.sha,
        displayURL: URL.createObjectURL(fileObj),
        path: file.path,
        name,
        size: fileObj.size,
        file: fileObj,
      };
    });
  }

  async loadEntryMediaFiles(files: { sha: string; path: string }[]) {
    const mediaFiles = await Promise.all(files.map(file => this.loadMediaFile(file)));

    return mediaFiles;
  }

  unpublishedEntries() {
    return this.api!.listUnpublishedBranches()
      .then(branches => {
        const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
        const promises = [] as Promise<null | ImplementationEntry>[];
        branches.map(({ ref }) => {
          promises.push(
            new Promise(resolve => {
              const contentKey = this.api!.contentKeyFromRef(ref);
              return sem.take(() =>
                this.api!.readUnpublishedBranchFile(contentKey)
                  .then((data: UnpublishedBranchResult) => {
                    if (data === null || data === undefined) {
                      resolve(null);
                      sem.leave();
                    } else {
                      resolve({
                        slug: this.api!.slugFromContentKey(contentKey, data.metaData.collection),
                        file: { path: data.metaData.objects.entry.path },
                        data: data.fileData,
                        metaData: data.metaData,
                        isModification: data.isModification,
                      });
                      sem.leave();
                    }
                  })
                  .catch(() => {
                    sem.leave();
                    resolve(null);
                  }),
              );
            }),
          );
        });
        return Promise.all(promises).then(entries =>
          entries.filter(entry => entry !== null),
        ) as Promise<ImplementationEntry[]>;
      })
      .catch(error => {
        if (error.message === 'Not Found') {
          return Promise.resolve([] as ImplementationEntry[]);
        }
        return Promise.reject(error);
      });
  }

  async unpublishedEntry(
    collection: Collection,
    slug: string,
    { loadEntryMediaFiles = (files: []) => this.loadEntryMediaFiles(files) } = {},
  ) {
    const contentKey = this.api!.generateContentKey(collection.get('name'), slug);
    const data = await this.api!.readUnpublishedBranchFile(contentKey);
    const files = get(data, 'metaData.objects.files', []);
    const mediaFiles = await loadEntryMediaFiles(files);
    return {
      slug,
      file: { path: data.metaData.objects.entry.path },
      data: data.fileData as string,
      metaData: data.metaData,
      mediaFiles,
      isModification: data.isModification,
    };
  }

  /**
   * Uses GitHub's Statuses API to retrieve statuses, infers which is for a
   * deploy preview via `getPreviewStatus`. Returns the url provided by the
   * status, as well as the status state, which should be one of 'success',
   * 'pending', and 'failure'.
   */
  async getDeployPreview(collectionName: string, slug: string) {
    const contentKey = this.api!.generateContentKey(collectionName, slug);
    const data = await this.api!.retrieveMetadata(contentKey);

    if (!data || !data.pr) {
      return null;
    }

    const headSHA = typeof data.pr.head === 'string' ? data.pr.head : data.pr.head.sha;
    const statuses = await this.api!.getStatuses(headSHA);
    const deployStatus = getPreviewStatus(statuses, this.config);

    if (deployStatus) {
      const { target_url: url, state } = deployStatus;
      return { url, status: state };
    } else {
      return null;
    }
  }

  updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    // updateUnpublishedEntryStatus is a transactional operation
    return this.runWithLock(
      () => this.api!.updateUnpublishedEntryStatus(collection, slug, newStatus),
      'Failed to acquire update entry status lock',
    );
  }

  deleteUnpublishedEntry(collection: string, slug: string) {
    // deleteUnpublishedEntry is a transactional operation
    return this.runWithLock(
      () => this.api!.deleteUnpublishedEntry(collection, slug),
      'Failed to acquire delete entry lock',
    );
  }

  publishUnpublishedEntry(collection: string, slug: string) {
    // publishUnpublishedEntry is a transactional operation
    return this.runWithLock(
      () => this.api!.publishUnpublishedEntry(collection, slug),
      'Failed to acquire publish entry lock',
    );
  }
}
