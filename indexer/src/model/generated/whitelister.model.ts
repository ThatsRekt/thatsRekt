import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_, IntColumn as IntColumn_, OneToMany as OneToMany_, Relation as Relation_} from "@subsquid/typeorm-store"
import {Post} from "./post.model"
import {Confirmation} from "./confirmation.model"
import {WhitelistChange} from "./whitelistChange.model"

@Entity_()
export class Whitelister {
    constructor(props?: Partial<Whitelister>) {
        Object.assign(this, props)
    }

    /**
     * the address (lowercased)
     */
    @PrimaryColumn_()
    id!: string

    @BooleanColumn_({nullable: false})
    isCurrentlyWhitelisted!: boolean

    @DateTimeColumn_({nullable: true})
    firstWhitelistedAt!: Date | undefined | null

    @IntColumn_({nullable: true})
    firstWhitelistedAtBlock!: number | undefined | null

    @DateTimeColumn_({nullable: true})
    lastChangedAt!: Date | undefined | null

    @IntColumn_({nullable: true})
    lastChangedAtBlock!: number | undefined | null

    @OneToMany_(() => Post, e => e.poster)
    posts!: Relation_<Post[]>

    @OneToMany_(() => Confirmation, e => e.confirmer)
    confirmationLog!: Relation_<Confirmation[]>

    @OneToMany_(() => WhitelistChange, e => e.addr)
    changes!: Relation_<WhitelistChange[]>
}
