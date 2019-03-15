# fast-delete

A customer needed to delete ~10 million files in a single "folder" of an Azure Blob Storage container which contained many millions of other files. Of course, there is no such thing as folders in Blob Storage, instead actually have a problem whereby there are 10s of millions of files in a container, but we need to delete all of them that start with a particular string for their filename. Simply iterating that number of files can be problematic.

We tried a couple options:

1. Azure Storage Explorer - The best result we could get was about 20 deletes/sec, or about 6 days to delete the 10 million documents.
2. az storage blob delete-batch - This has no progress indicator and as far as I could tell it was single-threaded, but it ran about 20 deletes/sec as well.

Since none of those solutions were ideal, I wrote fast-delete. If you have a small number of files to delete, this is probably more complex than you need, but if you have millions of blobs to delete, this might be a good fit.

CAUTION: This application is designed to delete files from blob storage very quickly, you need to be extremely careful you understand all the options and **test** it extensively to make sure it does what you expect. Use at your own risk, I am explicitly not providing any kind of guarantee.

## Installation

Install:

-   [Node.js](https://nodejs.org/en/download/)
-   [Git](https://git-scm.com/downloads)

```bash
git clone https://github.com/plasne/fast-delete
cd fast-delete
npm install
```

## Parameters

This application has a number of parameters that must be provided or can optionally be provided. You can get a complete list by typing "node delete -help".

```bash
$ node delete --help
Usage: delete [options]

Options:

  -V, --version          output the version number
  -a, --account <s>      [REQUIRED] STORAGE_ACCOUNT. The name of the Azure Storage Account.
  -c, --container <s>    [REQUIRED] STORAGE_CONTAINER. The name of the Azure Storage Account Container.
  -s, --sas <s>          [REQUIRED?] STORAGE_SAS. The Shared Access Signature querystring. Either STORAGE_SAS or STORAGE_KEY is required.
  -k, --key <s>          [REQUIRED?] STORAGE_KEY. The Azure Storage Account key. Either STORAGE_SAS or STORAGE_KEY is required.
  -l, --log-level <s>    LOG_LEVEL. The minimum level to log to the console (error, warn, info, verbose, debug, silly). Defaults to "info".
  -p, --prefix <s>       PREFIX. Specify to only delete blobs with this prefix. Ex. "20180101T000000/input".
  -m, --mode <s>         MODE. Can be "delete" or "test" (just shows what would be deleted). Defaults to "test".
  -x, --concurrency <i>  CONCURRENCY. The number of delete operations to perform at a time. Defaults to "100".
  -e, --on-error <s>     ON_ERROR. When an error is encountered during delete, the process can "halt" or "continue". Default is "halt".
  -r, --retries <i>      RETRIES. You can specify a number of times to retry the deletion. Default is "0".
  -h, --help             output usage information
```

There are several ways to provide these parameters. In order of precedence (command line preferred over variable or file, etc.):

1. Parameter provided on the command line.
2. Parameter set as an environment variable.
3. Parameter set in a .env file.

The .env file must be located in the folder you are executing the application from and should contain one environment variable per line as this example shows:

```bash
LOG_LEVEL=debug
ON_ERROR=continue
```

## Testing

Before you start deleting, you should run a test to make sure you understand what it going to be deleted (running in test mode is the default):

```bash
node delete --account <storage_account_name> --container <container_name> --sas <sas_querystring> --key <storage_key>
```

Either STORAGE_SAS (preferred) or STORAGE_KEY is required, but not both. STORAGE_SAS should be the entire string including the preceeding "?".

You would probably never delete everything in a container though because you could just delete the container, so you will be using PREFIX.

A more realistic example is:

```bash
node delete --account teststore --container files --key aafe...g=== --prefix 20180101T000000/
```

## Deletion

Once you have completed a test and are comfortable with what will be deleted, you can simply add "--mode delete" to your existing command. There are a few other options to consider though:

-   CONCURRENCY - You might experiment with this value to see where you get the best rate. I did notice some generalizations between Windows (~20 is better) and Linux (~100 is better).

-   ON_ERROR - The default is to "halt" on error, this is probably good to get started, but once you are confident, you might change this to "continue" for unattended execution.

-   RETRIES - By default, the application will attempt to delete every blob once and then terminate. However, you can set some retries and when the application has attempted to delete everything once, it can go back and try and second time, third, etc. I did notice that when running very large delete operations like this there were occational transient faults.

Example:

```bash
node delete --account teststore --container files --key aafe...g=== --prefix 20180101T000000/ --mode delete --concurrency 20 --on-error continue --retries 3
```

## Performance

There is quite a range of results I was able to record, but you can expect somewhere between 800 and 1500 deletes/second. Some things to consider to tweak performance:

-   Running other operations in your storage account might be slowing this down.
-   Running the delete from a VM in the same region might improve performance.
-   You can get radically different results running with a different number of threads, you should play around with CONCURRENCY.
-   I got the best results running on a Saturday morning.

I did testing on a number of different VM sizes, the performance capped out with a D4v3, so you do not need anything bigger than that.

## Scalability

There are 2 activities going on during this process:

1. The list of blobs is constantly being queried until this buffer exceeds 50,000. This process of iteration cannot be done in parallel (a pointer is being moved through the records).

2. The deletion of blobs is done in parallel at the specified CONCURRENCY.

Given the first constraint, the maximum throughput (records deleted per second) can be determined by running this application in test mode to see the iteration rate. Given perfect conditions, the deletion rate would match the iteration rate. To get close to that number, try adjusting CONCURRENCY.

Due to this same constraint, it does **not** benefit us to consider a more robust architecture (for example, scaling the deletion threads across Docker containers).

## Garbage Collection

After deleting 10 million documents and then creating some replacements into the same "folder", I observed much slower performance iterating the "folder". If we run test mode on the "folder" we will find that we are getting 2-8 items per call instead of the expected ~5,000.

After speaking with the product group, this is due to garbage collection. The collection time on 10 million documents is indeterminate but it is likely to be days to more than a week. When a page of blobs is requested, it finds 5,000 blobs and then trims that list based on what is deleted, so those pages can be very sparse if there is a lot of blobs marked for deletion.

## Windows vs. Linux

For this section assume the reference to "Linux" also includes macOS, while I realize they are not the same thing, the behavior was consistent.

-   Windows tended to have better throughput at a lower number of threads, 20-30.
-   Linux tended to have better throughput at a higher number of threads, ~100.
-   Windows tended to run out of ephemeral ports from time to time. This could probably help: [https://docs.oracle.com/cd/E26180_01/Search.94/ATGSearchAdmin/html/s1207adjustingtcpsettingsforheavyload01.html](https://docs.oracle.com/cd/E26180_01/Search.94/ATGSearchAdmin/html/s1207adjustingtcpsettingsforheavyload01.html).
-   As the CONCURRENCY gets higher, Windows tended to "leak" ephemeral ports (more were allocated than the connection pool) stipulated.

It honestly did not make that much difference in the final execution whether it was run on Windows or Linux, however, Linux will give a lot less errors and give you more room to fine-tune the CONCURRENCY.

## Architecture

There are a few architectural points that are worth calling out for those that are interested:

### Connection Pooling

I used [agentkeepalive](https://www.npmjs.com/package/agentkeepalive) to manage the maximum number of outbound sockets at CONCURRENCY + 50. The rest of the settings are default meaning that free ports will timeout after 1 minute. This is appropriate for Linux, but Windows uses a 2 minute timeout and I wonder if that is the cause of the leaked ports.

### REST API

The Azure Blob Storage REST API is used instead of the SDKs. This was done to ensure there was no loss of performance due to something in the SDK being done that wasn't necessary for this use case.

### Fetch

In both test and delete mode, a "fetch" process runs to get the first set of blobs (should be ~5,000). As soon as that set returns, another fetch is immediately started with the appropriate offset.

In the case of test mode, each blob filename is written to the logger and discarded. This continues until the list of all blobs has completed.

In the case of delete mode, the blob filenames are added to a buffer. The buffer is drained as described in the next section. The buffer is continually refilled by calling another fetch unless the buffer reaches 50k. At 50k, the fetch process delays for 1 second. If the buffer is below 50k, it will fetch more, otherwise, it will defer for another 1 second and so on. This behavior ensures that the buffer doesn't get too big and overflow the memory.

### Delete

I used [es6-promise-pool](https://www.npmjs.com/package/es6-promise-pool) to manage draining the buffer by deleting blobs. This module allows you to create a "producer" function that spits out Promises. Every time the pool drops below the desired CONCURRENCY, it asks the producer for another Promise. This elegant design ensures that the pool is always processing at the desired peak.

There are 3 things that can happen in the producer function:

1. The buffer could have 1 or more blob filename, in which case it will create a Promise to delete that blob.

2. The buffer could be empty but the fetch process is not done, in which case it create a Promise to delay for 1 second.

3. The buffer could be empty with nothing more to fetch, it will return "undefined". This triggers the pool to stop asking for new Promises.

## Future Enhancements

-   I would like to add a RegExp tester instead of simply prefix to be more flexible.

-   Sean Elliott suggested changing the iteration to prefix + [A-Z][0-9] and running multiple threads for that iteration. Using multiple threads for iteration should keep the buffer more full.
