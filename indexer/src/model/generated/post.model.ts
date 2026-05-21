import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, DateTimeColumn as DateTimeColumn_, StringColumn as StringColumn_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Whitelister} from "./whitelister.model"
import {PostAttacker} from "./postAttacker.model"
import {PostVictim} from "./postVictim.model"
import {Confirmation} from "./confirmation.model"
import {Edit} from "./edit.model"

@Entity_()
export class Post {
    constructor(props?: Partial<Post>) {
        Object.assign(this, props)
    }

    /**
     * postId from the contract
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Whitelister, {nullable: true})
    poster!: Relation_<Whitelister>

    /**
     * poster-supplied — block.timestamp of the malicious tx itself
     */
    @DateTimeColumn_({nullable: false})
    attackedAt!: Date

    /**
     * updated on amendTitle / amendNote / addAttackers / addVictims; mirrors on-chain field
     */
    @DateTimeColumn_({nullable: false})
    lastUpdatedAt!: Date

    /**
     * 1 on PostCreated; incremented by 1 on every amendment event
     * (PostNoteAmended, PostTitleAmended, AttackersAdded, VictimsAdded)
     */
    @IntColumn_({nullable: false})
    actionCount!: number

    /**
     * current title — required at post(), updatable via amendTitle()
     */
    @StringColumn_({nullable: false})
    title!: string

    /**
     * latest note text — historical edits captured in Edit entities
     */
    @StringColumn_({nullable: false})
    note!: string

    @IntColumn_({nullable: false})
    confirmations!: number

    @IntColumn_({nullable: false})
    disconfirmations!: number

    @IntColumn_({nullable: false})
    netScore!: number

    @BooleanColumn_({nullable: false})
    removed!: boolean

    /**
     * true iff governance has purged this post (PostPurged event); orthogonal to `removed`
     */
    @BooleanColumn_({nullable: false})
    purged!: boolean

    @IntColumn_({nullable: false})
    createdAtBlock!: number

    @DateTimeColumn_({nullable: false})
    createdAtTimestamp!: Date

    @IntColumn_({nullable: true})
    removedAtBlock!: number | undefined | null

    @DateTimeColumn_({nullable: true})
    removedAtTimestamp!: Date | undefined | null

    @IntColumn_({nullable: true})
    purgedAtBlock!: number | undefined | null

    @DateTimeColumn_({nullable: true})
    purgedAtTimestamp!: Date | undefined | null

    @OneToMany_(() => PostAttacker, e => e.post)
    attackerLinks!: Relation_<PostAttacker[]>

    @OneToMany_(() => PostVictim, e => e.post)
    victimLinks!: Relation_<PostVictim[]>

    @OneToMany_(() => Confirmation, e => e.post)
    confirmationLog!: Relation_<Confirmation[]>

    @OneToMany_(() => Edit, e => e.post)
    edits!: Relation_<Edit[]>
}
