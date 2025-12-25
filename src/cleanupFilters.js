import { google } from 'googleapis';
import { authorize } from './auth.js';
import chalk from 'chalk';
import ora from 'ora';

// Filters that should NEVER be marking emails as spam or trash
const PROTECTED_DOMAINS = [
  'chase.com',
  'capitalone.com',
  'paypal.com',
  'venmo.com',
  'mercury.com',
  'rippling.com',
  'uber.com',
  'lyft.com',
  'doordash.com',
  'google.com',
  'github.com',
  'discord.com',
  'opentable.com',
  'united.com',
  'delta.com',
  'walgreens.com',
  'coinbase.com',
  'robinhood.com',
  'apple.com',
  'citi.com'
];

// Overly broad patterns that catch too many legitimate emails
// These are patterns WITHOUT a domain - they match any sender with this prefix
const OVERLY_BROAD_PATTERNS = [
  'donotreply@',
  'members@',
  'verify@',
  'no-reply@',  // Only if no domain specified
  'noreply@',   // Only if no domain specified
  'alerts@',    // Only if no domain specified
  'notification@',
  'notify@'
];

class FilterCleanup {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async getAllFilters() {
    const response = await this.gmail.users.settings.filters.list({ userId: 'me' });
    return response.data.filter || [];
  }

  isProtectedDomain(email) {
    return PROTECTED_DOMAINS.some(domain => email.includes(domain));
  }

  isOverlyBroad(from) {
    // Only flag as overly broad if it's JUST a prefix without a full domain
    // e.g., "noreply@" is bad, but "noreply@uber.com" is fine
    return OVERLY_BROAD_PATTERNS.some(pattern => {
      // Exact match (e.g., "donotreply@" with no domain)
      if (from === pattern) return true;
      // Prefix match only if no proper domain follows
      if (from.startsWith(pattern)) {
        const afterPrefix = from.slice(pattern.length);
        // If there's no domain or just a partial domain, it's too broad
        return !afterPrefix.includes('.') || afterPrefix.length < 4;
      }
      return false;
    });
  }

  async analyzeFilters() {
    const spinner = ora('Analyzing filters...').start();
    const filters = await this.getAllFilters();

    const issues = {
      duplicates: [],
      protectedMarkedSpam: [],
      overlyBroad: [],
      conflicting: []
    };

    // Find duplicates by 'from' criteria
    const fromMap = new Map();
    for (const filter of filters) {
      const from = filter.criteria?.from;
      if (from) {
        if (!fromMap.has(from)) {
          fromMap.set(from, []);
        }
        fromMap.get(from).push(filter);
      }
    }

    for (const [from, filterList] of fromMap) {
      if (filterList.length > 1) {
        issues.duplicates.push({ from, count: filterList.length, filters: filterList });
      }
    }

    // Find protected domains marked as spam/trash
    for (const filter of filters) {
      const from = filter.criteria?.from || '';
      const action = filter.action || {};
      const addLabels = action.addLabelIds || [];

      if (this.isProtectedDomain(from)) {
        if (addLabels.includes('TRASH') || addLabels.some(l => l.toLowerCase().includes('spam'))) {
          issues.protectedMarkedSpam.push({ from, filter });
        }
      }
    }

    // Also get label names to check for "Likely Spam" label
    const labelsResponse = await this.gmail.users.labels.list({ userId: 'me' });
    const labelMap = new Map();
    for (const label of labelsResponse.data.labels || []) {
      labelMap.set(label.id, label.name);
    }

    // Re-check with label names resolved
    for (const filter of filters) {
      const from = filter.criteria?.from || '';
      const action = filter.action || {};
      const addLabelIds = action.addLabelIds || [];

      if (this.isProtectedDomain(from)) {
        const labelNames = addLabelIds.map(id => labelMap.get(id) || id);
        if (labelNames.some(name => name.toLowerCase().includes('spam'))) {
          // Check if not already added
          if (!issues.protectedMarkedSpam.find(i => i.filter.id === filter.id)) {
            issues.protectedMarkedSpam.push({ from, filter });
          }
        }
      }
    }

    // Find overly broad filters
    for (const filter of filters) {
      const from = filter.criteria?.from || '';
      if (this.isOverlyBroad(from) && !filter.criteria?.query) {
        issues.overlyBroad.push({ from, filter });
      }
    }

    spinner.succeed('Analysis complete');
    return { filters, issues };
  }

  async fixIssues(issues, dryRun = true) {
    const spinner = ora(dryRun ? 'Previewing fixes...' : 'Applying fixes...').start();
    const toDelete = [];

    // Collect duplicate filters (keep only the first one)
    for (const dup of issues.duplicates) {
      // Keep the first filter, delete the rest
      toDelete.push(...dup.filters.slice(1).map(f => ({ id: f.id, reason: `Duplicate: ${dup.from}` })));
    }

    // Collect protected domains marked as spam
    for (const item of issues.protectedMarkedSpam) {
      toDelete.push({ id: item.filter.id, reason: `Protected domain marked spam: ${item.from}` });
    }

    // Collect overly broad filters
    for (const item of issues.overlyBroad) {
      toDelete.push({ id: item.filter.id, reason: `Overly broad: ${item.from}` });
    }

    if (dryRun) {
      spinner.succeed(`Would delete ${toDelete.length} filters`);
      return toDelete;
    }

    let deleted = 0;
    for (const filter of toDelete) {
      try {
        await this.gmail.users.settings.filters.delete({
          userId: 'me',
          id: filter.id
        });
        deleted++;
        spinner.text = `Deleted ${deleted}/${toDelete.length} filters`;
        // Rate limiting
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`Failed to delete filter: ${err.message}`);
      }
    }

    spinner.succeed(`Deleted ${deleted} problematic filters`);
    return deleted;
  }

  displayReport(issues) {
    console.log('\n' + chalk.bold.cyan('Filter Analysis Report'));
    console.log(chalk.gray('='.repeat(50)));

    console.log(chalk.yellow(`\nDuplicate filters: ${issues.duplicates.length}`));
    issues.duplicates.slice(0, 10).forEach(dup => {
      console.log(`  - ${dup.from} (${dup.count} copies)`);
    });
    if (issues.duplicates.length > 10) {
      console.log(chalk.gray(`  ... and ${issues.duplicates.length - 10} more`));
    }

    console.log(chalk.red(`\nProtected domains marked as spam: ${issues.protectedMarkedSpam.length}`));
    issues.protectedMarkedSpam.forEach(item => {
      console.log(`  - ${item.from}`);
    });

    console.log(chalk.yellow(`\nOverly broad filters: ${issues.overlyBroad.length}`));
    issues.overlyBroad.forEach(item => {
      console.log(`  - ${item.from}`);
    });

    const total = issues.duplicates.reduce((acc, d) => acc + d.count - 1, 0) +
                  issues.protectedMarkedSpam.length +
                  issues.overlyBroad.length;

    console.log(chalk.bold.red(`\nTotal problematic filters: ${total}`));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  console.log(chalk.bold.cyan('\nGmail Filter Cleanup Tool\n'));

  if (dryRun) {
    console.log(chalk.yellow('Running in DRY RUN mode. Use --apply to actually delete filters.\n'));
  } else {
    console.log(chalk.red('Running in APPLY mode. Filters will be deleted!\n'));
  }

  const auth = await authorize();
  const cleanup = new FilterCleanup(auth);

  const { issues } = await cleanup.analyzeFilters();
  cleanup.displayReport(issues);

  if (dryRun) {
    const toDelete = await cleanup.fixIssues(issues, true);
    console.log('\nFilters that would be deleted:');
    toDelete.slice(0, 20).forEach(f => {
      console.log(chalk.gray(`  - ${f.reason}`));
    });
    if (toDelete.length > 20) {
      console.log(chalk.gray(`  ... and ${toDelete.length - 20} more`));
    }
    console.log(chalk.yellow('\nRun with --apply to delete these filters.'));
  } else {
    await cleanup.fixIssues(issues, false);
  }
}

main().catch(console.error);
